import { EventEmitter } from "../core/EventEmitter";
import { IPlaybackStrategy } from "../strategy/IPlaybackStrategy";
import { PlayerError, PlayerErrorCode, PlayerEventMap } from "../types/events";
import { StateManager } from "./StateManager";
import {
  AudioSourceInput,
  LoadOptions,
  DEFAULT_OPTIONS,
  HlsConstructor,
  normalizeSource,
  PlaybackMode,
  PlayerOptions,
  QualityLevel,
} from "../types/index";
import { CancellationError, CancellationToken } from "./CancellationToken";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import { PlayerState } from "../types";
import { HTML5Strategy } from "../strategy/Html5AudioStrategy";
import { WebAudioStrategy } from "../strategy/WebAudioStrategy";
import { AudioGraph } from "../audio/AudioGraph";
import { ISourceHandler, SourceManager } from "../source";
import {
  computeNormalizationGainDb,
  LoudnessMetadata,
  LoudnessNormalizationOptions,
} from "../audio/normalization";
import { playerLogger } from "../utils/Logger";
import { isCrossOrigin } from "../utils/url";

function inferLoadErrorCode(error: unknown): PlayerErrorCode {
  if (error instanceof PlayerError) {
    return error.code;
  }

  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.message === "Aborted")
  ) {
    return PlayerErrorCode.LOAD_ABORTED;
  }

  if (error instanceof TypeError) {
    return PlayerErrorCode.LOAD_NETWORK;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes("network")) {
      return PlayerErrorCode.LOAD_NETWORK;
    }

    if (message.includes("decode")) {
      return PlayerErrorCode.LOAD_DECODE;
    }

    if (message.includes("not supported") || message.includes("unsupported")) {
      return PlayerErrorCode.LOAD_NOT_SUPPORTED;
    }
  }

  return PlayerErrorCode.UNKNOWN;
}

type ResolvedPlayerOptions = Required<
  Omit<PlayerOptions, "Hls" | "loudnessNormalization">
> & {
  loudnessNormalization: Required<LoudnessNormalizationOptions>;
  Hls?: HlsConstructor;
};

export class Player extends EventEmitter<PlayerEventMap> {
  private _ctx: AudioContext | null = null;
  private _stateManager: StateManager;
  private _sourceManager: SourceManager;
  private _audioGraph: AudioGraph | null = null;
  private _graphSourceNode: AudioNode | null = null;
  /** Whether the current load routes the strategy through the Web Audio graph. */
  private _routeGraphForLoad = true;

  private _currentStrategy: IPlaybackStrategy | null = null;
  private _currentHandler: ISourceHandler | null = null;
  private _cancellation: CancellationToken | null = null;

  private _options: ResolvedPlayerOptions;
  private _volume: Volume;
  private _muted: boolean;
  private _playbackRate: PlaybackRate;
  private _loop: boolean;

  private _objectUrls: Set<string> = new Set();

  private _loudnessMetadata: LoudnessMetadata | null = null;

  private _isAudioUnlocked = false;
  private _isAudioUnlocking = false;

  private _previousCtxState: AudioContextState | null = null;

  constructor(options: PlayerOptions = {}) {
    super();

    const loudnessNormalization: Required<LoudnessNormalizationOptions> = {
      ...DEFAULT_OPTIONS.loudnessNormalization,
      ...(options.loudnessNormalization ?? {}),
    };

    this._options = {
      ...DEFAULT_OPTIONS,
      ...options,
      hlsConfig: {
        ...DEFAULT_OPTIONS.hlsConfig,
        ...(options.hlsConfig ?? {}),
      },
      loudnessNormalization,
    };

    this._stateManager = new StateManager();

    this._sourceManager = new SourceManager({
      hlsConfig: this._options.hlsConfig,
      Hls: this._options.Hls,
    });

    this._volume = Volume(this._options.volume);
    this._muted = this._options.muted;
    this._playbackRate = PlaybackRate(this._options.playbackRate);
    this._loop = this._options.loop;

    this._stateManager.onChange(({ from, to }) => {
      this.emit("statechange", { from, to });
    });
  }

  get state(): PlayerState {
    return this._stateManager.state;
  }

  get duration(): TimeSeconds {
    return this._currentStrategy?.duration ?? TimeSeconds(0);
  }

  get currentTime(): TimeSeconds {
    return this._currentStrategy?.getCurrentTime() ?? TimeSeconds(0);
  }

  get volume(): Volume {
    return this._volume;
  }

  get muted(): boolean {
    return this._muted;
  }

  get playbackRate(): PlaybackRate {
    return this._playbackRate;
  }

  get loop(): boolean {
    return this._loop;
  }

  get isPlaying(): boolean {
    return this._currentStrategy?.isPlaying ?? false;
  }

  get isReady(): boolean {
    return this._stateManager.isPlayable;
  }

  get isFading(): boolean {
    return this._audioGraph?.isFading ?? false;
  }

  get mode(): PlaybackMode {
    if (!this._currentStrategy) return "auto";
    return this._currentStrategy.id;
  }

  get audioContext(): AudioContext {
    if (!this._ctx) {
      const WebAudioCtx: typeof AudioContext =
        window.AudioContext ?? (window as any).webkitAudioContext;

      this._ctx = new WebAudioCtx({
        latencyHint: this._options.latencyHint,
      });

      this._previousCtxState = this._ctx.state;

      this._ctx.onstatechange = () => {
        if (!this._ctx) return;

        const state = this._ctx.state;
        const prevState = this._previousCtxState;

        this._previousCtxState = state;

        if (state === "interrupted") {
          playerLogger.debug("AudioContext interrupted");
          this.emit("contextinterrupted");
        }

        if (state === "suspended" && prevState === "interrupted") {
          playerLogger.debug(
            "AudioContext interrupted → suspended, auto-resuming",
          );

          void this.unfreezeAudioContext();
        }

        if (
          state === "running" &&
          (prevState === "suspended" || prevState === "interrupted")
        ) {
          playerLogger.debug("AudioContext resumed");
          this.emit("contextresumed");
          this._resyncStrategyClock();
        }
      };
    }

    return this._ctx;
  }

  async getAudioContext(): Promise<AudioContext> {
    const ctx = this.audioContext;

    if (ctx.state === "closed") {
      this._ctx = null;
      return this.audioContext;
    }

    if (ctx.state === "suspended" || ctx.state === "interrupted") {
      await this.unfreezeAudioContext();
    }

    return ctx;
  }

  async freezeAudioContext(): Promise<void> {
    if (!this._ctx || this._ctx.state === "closed") {
      return;
    }

    if (typeof this._ctx.suspend === "undefined") {
      return Promise.resolve();
    }

    return this._ctx.suspend();
  }

  async unfreezeAudioContext(): Promise<void> {
    if (!this._ctx || this._ctx.state === "closed") {
      return;
    }

    if (typeof this._ctx.resume === "undefined") {
      return Promise.resolve();
    }

    return this._ctx.resume();
  }

  isAudioContextFrozen(): boolean {
    return this._ctx?.state === "suspended";
  }

  private _resyncStrategyClock(): void {
    if (this._currentStrategy instanceof WebAudioStrategy) {
      playerLogger.debug(
        "Resyncing WebAudioStrategy clock after context resume",
      );

      this._currentStrategy.resyncStartTime();
    }
  }

  async unlockAudio(): Promise<void> {
    if (this._isAudioUnlocking || this._isAudioUnlocked) {
      return;
    }

    this._isAudioUnlocking = true;

    try {
      const ctx = await this.getAudioContext();

      await new Promise<void>((resolve, reject) => {
        const placeholder = ctx.createBuffer(1, 1, 22050);

        let source: AudioBufferSourceNode | null = ctx.createBufferSource();

        source.buffer = placeholder;
        source.connect(ctx.destination);

        source.onended = () => {
          source?.disconnect();
          if (source) {
            source.buffer = null;
          }

          source = null;

          this._isAudioUnlocked = true;
          this._isAudioUnlocking = false;

          resolve();
        };

        try {
          source.start(0);
        } catch (err) {
          source.disconnect();
          source = null;

          reject(err);
        }
      });
    } catch (err) {
      this._isAudioUnlocking = false;
      throw err;
    }
  }

  get graph(): AudioGraph | null {
    return this._audioGraph;
  }

  get graphOrThrow(): AudioGraph {
    if (!this._audioGraph) {
      throw new PlayerError(
        "AudioGraph is not ready. Call load() (and play()) first.",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    return this._audioGraph;
  }

  get loudnessMetadata(): LoudnessMetadata | null {
    return this._loudnessMetadata;
  }

  get normalizationEnabled(): boolean {
    return this._options.loudnessNormalization.enabled;
  }

  get targetLufs(): number {
    return this._options.loudnessNormalization.targetLufs;
  }

  get normalizationOptions(): Required<LoudnessNormalizationOptions> {
    return this._options.loudnessNormalization;
  }

  getAppliedNormalizationGainDb(): number {
    return this._audioGraph?.getNormalizationGainDb() ?? 0;
  }

  async load(source: AudioSourceInput, loadOptions?: LoadOptions): Promise<void> {
    const normalized = normalizeSource(source);

    // Per-load overrides on top of the constructor options (F-02 mixed playlists).
    const routingPolicy =
      loadOptions?.webAudioRouting ?? this._options.webAudioRouting;
    const corsFallback =
      loadOptions?.corsFallback ?? this._options.corsFallback;

    if (this._stateManager.isDisposed) {
      throw new PlayerError(
        "Player is disposed",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    this._cancellation?.cancel();

    this._cancellation = new CancellationToken();

    const signal = this._cancellation.signal;

    const isCurrentLoad = (): boolean => this._cancellation?.signal === signal;

    await this.cleanup();

    this._stateManager.transition("loading");

    this.emit("loadstart");

    try {
      const handler = this._sourceManager.getHandler(normalized);

      this._currentHandler = handler;

      let strategyType =
        this._options.mode === "auto"
          ? this._sourceManager.recommendStrategy(normalized)
          : this._options.mode;

      const preferred = handler.preferredStrategy();

      if (preferred !== "any" && preferred !== strategyType) {
        playerLogger.warn(
          `Source requires ${preferred} strategy, switching from ${strategyType}`,
        );

        strategyType = preferred;
      }

      this._currentStrategy = this.createStrategy(strategyType);

      // Web Audio (buffer) sources always route. HTML5 routes only when
      // webAudioRouting is 'always'; a CORS fallback may drop it to false below.
      let routeGraph =
        strategyType === "webaudio" || routingPolicy === "always";

      const prepareCtx = strategyType === "webaudio" ? this.audioContext : null;

      playerLogger.debug(
        "Preparing source",
        normalized.type || "url",
        normalized.url || normalized.data ? "data" : "",
      );

      const prepared = await handler.prepare(
        normalized,
        this._currentStrategy,
        prepareCtx,
        signal,
      );

      signal.throwIfAborted();

      if (prepared.objectUrlToRevoke) {
        this._objectUrls.add(prepared.objectUrlToRevoke);
      }

      this._sourceManager.setActiveHandler(handler);

      // Only resolve an AudioContext when this load actually routes — an
      // un-routed html5 load ('never' or CORS fallback) must not create one.
      const initStrategy = async (): Promise<void> => {
        await this._currentStrategy!.initialize({
          sourceUrl: prepared.sourceUrl,
          audioBuffer: prepared.audioBuffer,
          audioContext: routeGraph ? this.audioContext : undefined,
          volume: this._volume,
          muted: this._muted,
          playbackRate: this._playbackRate,
          loop: this._loop,
          preload: this._options.preload,
          metadata: prepared.metadata,
          requiresCrossOrigin: strategyType === "html5" && routeGraph,
          signal,
        });
      };

      const crossOriginWasSet =
        strategyType === "html5" &&
        routeGraph &&
        !!prepared.sourceUrl &&
        isCrossOrigin(prepared.sourceUrl);

      try {
        await initStrategy();
      } catch (err) {
        const abortish =
          err instanceof CancellationError ||
          (err instanceof DOMException && err.name === "AbortError");

        if (
          !corsFallback ||
          !crossOriginWasSet ||
          abortish ||
          !isCurrentLoad()
        ) {
          throw err;
        }

        signal.throwIfAborted();

        playerLogger.warn(
          "CORS media error — retrying without crossOrigin; " +
            "EQ/fades/analyser/normalization are disabled for this track.",
        );

        this._currentStrategy.dispose();
        routeGraph = false;
        this._currentStrategy = this.createStrategy(strategyType);

        await initStrategy();
      }

      signal.throwIfAborted();

      this._routeGraphForLoad = routeGraph;

      this.bindStrategyEvents();

      this.setupAudioGraph();

      this.recomputeNormalization();

      this._stateManager.transition("ready");

      this.emit("loadedmetadata", {
        duration: this.duration,
      });

      this.emit("canplay");

      playerLogger.debug("Load complete, duration:", this.duration);

      const capabilities = this._sourceManager.getActiveCapabilities();

      // Runtime (post-load) error channel: the handler (e.g. HLS) surfaces
      // unrecoverable errors here after its own recovery is exhausted (F-07).
      capabilities?.onRuntimeError?.((err) => this.handleRuntimeError(err));

      if (capabilities?.qualityLevels?.length) {
        this.emit("qualitiesavailable", capabilities.qualityLevels);
      }

      if (this._options.autoplay) {
        // load() succeeds once the source is ready. A blocked/failed autoplay
        // is a separate signal: play() already emitted exactly one
        // PLAYBACK_NOT_ALLOWED error event, so swallow here — do NOT reject
        // load() or re-emit, and keep the state at "ready" (F-04).
        try {
          await this.play();
        } catch (err) {
          playerLogger.debug("Autoplay blocked after load", err);
        }
      }
    } catch (err) {
      if (!isCurrentLoad()) {
        // A newer load() superseded this one. Any error here belongs to the
        // abandoned load and MUST NOT touch the current load's state/FSM.
        playerLogger.debug("Ignoring error from superseded load", err);
        return;
      }

      if (
        err instanceof CancellationError ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        this._stateManager.transition("idle");

        return;
      }

      this._stateManager.transition("error");

      const playerError = PlayerError.fromError(err, inferLoadErrorCode(err));

      this.emit("error", {
        code: playerError.code,
        message: playerError.message,
        cause: playerError.cause,
      });

      throw playerError;
    }
  }

  /**
   * Surfaces an unrecoverable runtime error from the active handler (e.g. an
   * HLS fatal error after recovery is exhausted): emit once and transition to
   * error. Recoverable errors never reach here — the handler retries silently.
   */
  private handleRuntimeError(error: PlayerError): void {
    playerLogger.error("Runtime error:", error);

    this._stateManager.transition("error");

    this.emit("error", {
      code: error.code,
      message: error.message,
      cause: error.cause,
    });
  }

  async play(): Promise<void> {
    if (!this._currentStrategy) {
      throw new PlayerError(
        "Nothing to play. Call load() first.",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    if (this._stateManager.is("playing")) {
      return;
    }

    // Load-generation guard: capture the strategy/signal owning this play() so a
    // newer load() that supersedes us mid-await cannot mutate state for a
    // stale/disposed strategy (F-06).
    const strategy = this._currentStrategy;
    const signal = this._cancellation?.signal;
    const isCurrent = (): boolean =>
      this._currentStrategy === strategy &&
      this._cancellation?.signal === signal;

    // Un-routed html5 playback needs no AudioContext — the element plays on its
    // own. Only resolve/resume a context when this load routes through the graph.
    if (this._routeGraphForLoad) {
      await this.getAudioContext();

      if (!isCurrent()) {
        playerLogger.debug(
          "play() superseded during getAudioContext; ignoring",
        );
        return;
      }

      if (!this._graphSourceNode) {
        this.setupAudioGraph();
      }
    }

    try {
      await this._currentStrategy.play();
    } catch (error) {
      if (!isCurrent()) {
        playerLogger.debug(
          "play() failed after being superseded; ignoring",
          error,
        );

        return;
      }

      playerLogger.error("Playback failed:", error);

      const playerError = PlayerError.fromError(
        error,
        PlayerErrorCode.PLAYBACK_NOT_ALLOWED,
      );

      this.emit("error", {
        code: playerError.code,
        message: playerError.message,
        cause: playerError.cause,
      });

      throw playerError;
    }

    if (!isCurrent()) {
      playerLogger.debug("play() resolved after a newer load(); ignoring");

      return;
    }

    this._stateManager.transition("playing");

    playerLogger.debug("Playback started");
  }

  pause(): void {
    // F-10: allow pause() from buffering too (buffering→paused is valid).
    if (!this._currentStrategy || !this._stateManager.isActive) {
      return;
    }

    this._currentStrategy.pause();

    this._stateManager.transition("paused");

    playerLogger.debug("Playback paused");
  }

  async togglePlay(): Promise<void> {
    // F-10: base the decision on FSM activity, not strategy.isPlaying, which
    // diverges from the state while stalled (buffering).
    if (this._stateManager.isActive) {
      this.pause();
    } else {
      await this.play();
    }
  }

  stop(): void {
    if (!this._currentStrategy) {
      return;
    }

    this._currentStrategy.stop();

    this._stateManager.transition("ready");

    this.emit("stop");

    playerLogger.debug("Playback stopped");
  }

  seek(time: number): void {
    if (!this._currentStrategy) {
      return;
    }

    const safeTime = TimeSeconds(Math.max(0, Math.min(time, this.duration)));

    playerLogger.debug("Seeking to:", safeTime);

    this.emit("seeking", safeTime);

    this._currentStrategy.seek(safeTime);

    this.emit("seeked", safeTime);
  }

  seekPercent(percent: number): void {
    const time = this.duration * Math.max(0, Math.min(1, percent));

    this.seek(time);
  }

  setVolume(value: number): void {
    this._volume = Volume(value);

    if (this._currentStrategy instanceof HTML5Strategy) {
      this._currentStrategy.setVolume(this._volume);
    } else if (this._audioGraph) {
      this._audioGraph.setVolume(this._muted ? 0 : this._volume);

      this._currentStrategy?.setVolume(Volume(1));
    } else {
      this._currentStrategy?.setVolume(this._volume);
    }

    this.emit("volumechange", {
      volume: this._volume,
      muted: this._muted,
    });
  }

  setMuted(muted: boolean): void {
    this._muted = muted;

    if (this._currentStrategy instanceof HTML5Strategy) {
      this._currentStrategy.setMuted(muted);
    } else if (this._audioGraph) {
      this._currentStrategy?.setMuted(false);

      this._audioGraph.setVolume(muted ? 0 : this._volume);
    } else {
      this._currentStrategy?.setMuted(muted);
    }

    this.emit("volumechange", {
      volume: this._volume,
      muted: this._muted,
    });
  }

  toggleMute(): void {
    this.setMuted(!this._muted);
  }

  setPlaybackRate(rate: number): void {
    this._playbackRate = PlaybackRate(rate);

    this._currentStrategy?.setPlaybackRate(this._playbackRate);

    this.emit("ratechange", this._playbackRate);
  }

  setLoop(loop: boolean): void {
    this._loop = loop;

    this._currentStrategy?.setLoop(loop);
  }

  async fadeTo(volume: number, durationSec: number = 1): Promise<void> {
    if (!this._audioGraph) {
      return;
    }

    await this._audioGraph.fadeTo(
      Math.max(0, Math.min(1, volume)),
      durationSec,
    );
  }

  async fadeIn(durationSec: number = 1): Promise<void> {
    if (!this._audioGraph || !this._currentStrategy) {
      return;
    }

    let startFrom: number | undefined = 0;

    if (!this.isPlaying) {
      await this._audioGraph.fadeTo(0, 0);

      await this.play();
    } else {
      // Already playing: continue from the current gain instead of
      // forcing an audible drop to silence before ramping back up.
      startFrom = undefined;
    }

    const targetVol = this.getRestingGraphGain();

    await this._audioGraph.fadeTo(targetVol, durationSec, startFrom);
  }

  async fadeOut(durationSec: number = 1): Promise<void> {
    if (!this._audioGraph) {
      return;
    }

    await this._audioGraph.fadeTo(0, durationSec);
  }

  async fadeOutAndPause(durationSec: number = 1): Promise<void> {
    await this.fadeOut(durationSec);

    this.pause();

    void this._audioGraph?.fadeTo(this.getRestingGraphGain(), 0);
  }

  async fadeOutAndStop(durationSec: number = 1): Promise<void> {
    await this.fadeOut(durationSec);

    this.stop();

    void this._audioGraph?.fadeTo(this.getRestingGraphGain(), 0);
  }

  cancelFade(): void {
    this._audioGraph?.cancelFade();
  }

  setLoudnessMetadata(metadata: LoudnessMetadata | null): void {
    this._loudnessMetadata = metadata;

    this.recomputeNormalization();
  }

  getLoudnessMetadata(): LoudnessMetadata | null {
    return this._loudnessMetadata;
  }

  clearLoudnessMetadata(): void {
    this._loudnessMetadata = null;

    this.recomputeNormalization();
  }

  setNormalizationEnabled(enabled: boolean): void {
    this._options.loudnessNormalization.enabled = enabled;

    this.recomputeNormalization();
  }

  setTargetLufs(targetLufs: number): void {
    this._options.loudnessNormalization.targetLufs = targetLufs;

    this.recomputeNormalization();
  }

  setNormalizationOptions(options: LoudnessNormalizationOptions): void {
    this._options.loudnessNormalization = {
      ...this._options.loudnessNormalization,
      ...options,
    };

    this.recomputeNormalization();
  }

  recomputeNormalization(): void {
    if (!this._audioGraph) {
      return;
    }

    const opts = this._options.loudnessNormalization;

    if (!opts.enabled || !this._loudnessMetadata) {
      this._audioGraph.resetNormalization();

      this.emit("normalizationchange", {
        enabled: false,
        gainDb: 0,
        targetLufs: opts.targetLufs,
        metadata: this._loudnessMetadata,
      });

      return;
    }

    const gainDb = computeNormalizationGainDb({
      measuredLufs: this._loudnessMetadata.integratedLufs,
      targetLufs: opts.targetLufs,
      truePeakDbtp: this._loudnessMetadata.truePeakDbtp,
      preventClipping: opts.preventClipping,
      headroomDb: opts.headroomDb,
      maxGainDb: opts.maxGainDb,
      maxAttenuationDb: opts.maxAttenuationDb,
    });

    this._audioGraph.setNormalizationGainDbSmooth(gainDb, opts.smoothTimeSec);

    this.emit("normalizationchange", {
      enabled: true,
      gainDb,
      targetLufs: opts.targetLufs,
      metadata: this._loudnessMetadata,
    });
  }

  resetNormalization(): void {
    this._audioGraph?.resetNormalization();

    this.emit("normalizationchange", {
      enabled: false,
      gainDb: 0,
      targetLufs: this._options.loudnessNormalization.targetLufs,
      metadata: this._loudnessMetadata,
    });
  }

  getQualityLevels(): QualityLevel[] {
    return this._sourceManager.getActiveCapabilities()?.qualityLevels ?? [];
  }

  setQuality(level: number): void {
    const capabilities = this._sourceManager.getActiveCapabilities();

    capabilities?.setQuality?.(level);

    const levels = this.getQualityLevels();

    const current = levels[level];

    if (current) {
      this.emit("qualitychange", current);
    }
  }

  getCurrentQuality(): number {
    return (
      this._sourceManager.getActiveCapabilities()?.getCurrentQuality?.() ?? -1
    );
  }

  async dispose(): Promise<void> {
    if (this._stateManager.isDisposed) {
      return;
    }

    playerLogger.debug("Disposing player");

    this._cancellation?.cancel();

    await this.cleanup();

    if (this._ctx) {
      this._ctx.onstatechange = null;

      if (this._ctx.state !== "closed") {
        await this._ctx.close();
      }
    }

    this._ctx = null;

    this._audioGraph?.dispose();
    this._audioGraph = null;

    this._graphSourceNode = null;

    this._sourceManager.dispose();

    this._stateManager.dispose();

    this.emit("dispose");

    this.removeAllListeners();
  }

  private createStrategy(type: "html5" | "webaudio"): IPlaybackStrategy {
    switch (type) {
      case "html5":
        return new HTML5Strategy();

      case "webaudio":
        return new WebAudioStrategy();

      default:
        return new HTML5Strategy();
    }
  }

  private setupAudioGraph(): void {
    if (!this._currentStrategy) {
      return;
    }

    if (!this._routeGraphForLoad) {
      // Routing disabled for this load ('never' or CORS fallback): no graph,
      // no AudioContext. Tear down any graph left from a prior routed load so
      // player.graph === null for this track. Must return BEFORE touching the
      // audioContext getter so no context is created.
      this.teardownGraph();
      return;
    }

    if (this._graphSourceNode) {
      return;
    }

    if (!this._audioGraph) {
      this._audioGraph = new AudioGraph(this.audioContext);
    }

    const sourceNode = this._currentStrategy.connectToGraph(this.audioContext);

    this._graphSourceNode = sourceNode;

    this._audioGraph.setVolumeImmediate(this.getRestingGraphGain());

    this._audioGraph.output.disconnect();

    this._audioGraph.output.connect(this.audioContext.destination);

    sourceNode.connect(this._audioGraph.input);

    if (this._currentStrategy instanceof HTML5Strategy) {
      this._currentStrategy.setVolume(this._volume);

      this._currentStrategy.setMuted(this._muted);
    } else {
      this._currentStrategy.setVolume(Volume(1));

      this._currentStrategy.setMuted(false);
    }
  }

  private teardownGraph(): void {
    this._graphSourceNode?.disconnect();
    this._graphSourceNode = null;

    this._audioGraph?.dispose();
    this._audioGraph = null;
  }

  private getRestingGraphGain(): number {
    if (this._currentStrategy instanceof HTML5Strategy) {
      return 1;
    }

    return this._muted ? 0 : this._volume;
  }

  private bindStrategyEvents(): void {
    if (!this._currentStrategy) {
      return;
    }

    this._currentStrategy.on("play", () => {
      this.emit("play");
    });

    if (this._currentStrategy instanceof HTML5Strategy) {
      // A handler that owns a runtime-error channel (HLS) surfaces element
      // failures itself; attaching the element error handler too would emit the
      // error twice. Only attach it when no such channel exists.
      if (!this._sourceManager.getActiveCapabilities()?.onRuntimeError) {
        this._currentStrategy.attachErrorHandler();
      }
    }

    this._currentStrategy.on("pause", () => {
      this.emit("pause");
    });

    this._currentStrategy.on("ended", () => {
      this._stateManager.transition("ready");

      this.emit("ended");
    });

    this._currentStrategy.on("timeupdate", (time) => {
      this.emit("timeupdate", {
        currentTime: time,
        duration: this.duration,
        progress: this.duration > 0 ? time / this.duration : 0,
      });
    });

    this._currentStrategy.on("durationchange", (duration) => {
      this.emit("durationchange", duration);
    });

    this._currentStrategy.on("canplaythrough", () => {
      this.emit("canplaythrough");
    });

    this._currentStrategy.on("buffered", () => {
      this.emit("buffered");
    });

    this._currentStrategy.on("waiting", () => {
      this._stateManager.transition("buffering");

      this.emit("waiting");
    });

    this._currentStrategy.on("playing", () => {
      if (this._stateManager.is("buffering")) {
        this._stateManager.transition("playing");
      }

      this.emit("playing");
    });

    this._currentStrategy.on("error", (error) => {
      this._stateManager.transition("error");

      const playerError = PlayerError.fromError(
        error,
        PlayerErrorCode.PLAYBACK_FAILED,
      );

      this.emit("error", {
        code: playerError.code,
        message: playerError.message,
        cause: playerError.cause,
      });
    });
  }

  private async cleanup(): Promise<void> {
    this._audioGraph?.cancelFade();

    this._audioGraph?.resetNormalization();

    this._currentStrategy?.dispose();
    this._currentStrategy = null;

    this._graphSourceNode = null;

    this._currentHandler?.dispose();
    this._currentHandler = null;

    this._sourceManager.clearActiveHandler();

    for (const url of this._objectUrls) {
      URL.revokeObjectURL(url);
    }

    this._objectUrls.clear();

    this._stateManager.reset();
  }

  static forMusic(options?: PlayerOptions): Player {
    return new Player({
      mode: "auto",
      latencyHint: "playback",
      ...options,
    });
  }

  static forStreaming(options?: PlayerOptions): Player {
    return new Player({
      mode: "html5",
      latencyHint: "playback",
      preload: "metadata",
      ...options,
    });
  }

  static auto(options?: PlayerOptions): Player {
    return new Player({
      mode: "auto",
      ...options,
    });
  }
}
