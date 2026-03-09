import { EventEmitter } from "../core/EventEmitter";
import { IPlaybackStrategy } from "../strategy/IPlaybackStrategy";
import { PlayerError, PlayerErrorCode, PlayerEventMap } from "../types/events";
import { StateManager } from "./StateManager";
import {
  AudioSourceInput,
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
import { playerLogger } from "../utils/Logger";

type ResolvedPlayerOptions = Required<Omit<PlayerOptions, "Hls">> & {
  Hls?: HlsConstructor;
};

export class Player extends EventEmitter<PlayerEventMap> {
  private _ctx: AudioContext | null = null;
  private _stateManager: StateManager;
  private _sourceManager: SourceManager;
  private _audioGraph: AudioGraph | null = null;

  private _currentStrategy: IPlaybackStrategy | null = null;
  private _currentHandler: ISourceHandler | null = null;
  private _cancellation: CancellationToken | null = null;

  private _options: ResolvedPlayerOptions;
  private _volume: Volume;
  private _muted: boolean;
  private _playbackRate: PlaybackRate;
  private _loop: boolean;

  private _objectUrls: Set<string> = new Set();

  constructor(options: PlayerOptions = {}) {
    super();

    this._options = { ...DEFAULT_OPTIONS, ...options };

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
      this._ctx = new AudioContext({
        latencyHint: this._options.latencyHint,
      });
    }
    return this._ctx;
  }

  get graph(): AudioGraph | null {
    return this._audioGraph;
  }

  async load(source: AudioSourceInput): Promise<void> {
    const normalized = normalizeSource(source);

    if (this._stateManager.isDisposed) {
      throw new PlayerError(
        "Player is disposed",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    this._cancellation?.cancel();
    this._cancellation = new CancellationToken();
    const signal = this._cancellation.signal;

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
        console.warn(
          `[Player] Source requires ${preferred} strategy, switching from ${strategyType}`,
        );
        strategyType = preferred;
      }

      this._currentStrategy = this.createStrategy(strategyType);

      const needsContext = strategyType === "webaudio";
      const ctx = needsContext ? this.audioContext : null;

      const prepared = await handler.prepare(
        normalized,
        this._currentStrategy,
        ctx,
        signal,
      );

      signal.throwIfAborted();

      if (prepared.objectUrlToRevoke) {
        this._objectUrls.add(prepared.objectUrlToRevoke);
      }

      this._sourceManager.setActiveHandler(handler);

      await this._currentStrategy.initialize({
        sourceUrl: prepared.sourceUrl,
        audioBuffer: prepared.audioBuffer,
        audioContext: this.audioContext,
        volume: this._volume,
        muted: this._muted,
        playbackRate: this._playbackRate,
        loop: this._loop,
        preload: this._options.preload,
      });

      signal.throwIfAborted();

      this.setupAudioGraph();

      this.bindStrategyEvents();

      this._stateManager.transition("ready");
      this.emit("canplay");
      this.emit("loadedmetadata", { duration: this.duration });

      const capabilities = this._sourceManager.getActiveCapabilities();
      if (capabilities?.qualityLevels?.length) {
        this.emit("qualitiesavailable", capabilities.qualityLevels);
      }

      if (this._options.autoplay) {
        await this.play();
      }
    } catch (err) {
      if (
        err instanceof CancellationError ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        this._stateManager.transition("idle");
        return;
      }

      this._stateManager.transition("error");
      const playerError = PlayerError.fromError(
        err,
        PlayerErrorCode.LOAD_DECODE,
      );
      this.emit("error", {
        code: playerError.code,
        message: playerError.message,
        cause: playerError.cause,
      });
      throw playerError;
    }
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

    if (this._ctx?.state === "suspended") {
      await this._ctx.resume();
    }

    try {
      await this._currentStrategy.play();
      this._stateManager.transition("playing");
    } catch (error) {
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
  }

  pause(): void {
    if (!this._currentStrategy || !this._stateManager.is("playing")) {
      return;
    }

    this._currentStrategy.pause();
    this._stateManager.transition("paused");
  }

  async togglePlay(): Promise<void> {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  stop(): void {
    if (!this._currentStrategy) return;

    this._currentStrategy.stop();
    this._stateManager.transition("ready");
    this.emit("stop");
  }

  seek(time: number): void {
    if (!this._currentStrategy) return;

    const safeTime = TimeSeconds(Math.max(0, Math.min(time, this.duration)));

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

    if (this._audioGraph) {
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

    if (this._audioGraph) {
      this._currentStrategy?.setMuted(false);
      this._audioGraph.setVolume(muted ? 0 : this._volume);
    } else {
      this._currentStrategy?.setMuted(muted);
    }

    this.emit("volumechange", { volume: this._volume, muted: this._muted });
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
    if (!this._audioGraph) return;
    await this._audioGraph.fadeTo(
      Math.max(0, Math.min(1, volume)),
      durationSec,
    );
  }

  async fadeIn(durationSec: number = 1): Promise<void> {
    if (!this._audioGraph || !this._currentStrategy) return;

    playerLogger.debug(
      `[Player.fadeIn] duration=${durationSec}s, isPlaying=${this.isPlaying}`,
    );

    if (!this.isPlaying) {
      await this._audioGraph.fadeTo(0, 0);
      await this.play();
    }

    const targetVol = this._muted ? 0 : this._volume;
    playerLogger.debug(`[Player.fadeIn] target=${targetVol}`);
    await this._audioGraph.fadeTo(targetVol, durationSec, 0);
    playerLogger.debug(`[Player.fadeIn] complete`);
  }

  async fadeOut(durationSec: number = 1): Promise<void> {
    if (!this._audioGraph) return;
    playerLogger.debug(`[Player.fadeOut] duration=${durationSec}s`);
    await this._audioGraph.fadeTo(0, durationSec);
    playerLogger.debug(
      `[Player.fadeOut] complete, gain=${this._audioGraph.output}`,
    );
  }

  async fadeOutAndPause(durationSec: number = 1): Promise<void> {
    playerLogger.debug(`[Player.fadeOutAndPause] start`);
    await this.fadeOut(durationSec);
    playerLogger.debug(`[Player.fadeOutAndPause] fade done, calling pause()`);
    this.pause();
    playerLogger.debug(`[Player.fadeOutAndPause] paused, restoring volume`);
    void this._audioGraph?.fadeTo(this._muted ? 0 : this._volume, 0);
  }
  async fadeOutAndStop(durationSec: number = 1): Promise<void> {
    playerLogger.debug(`[Player.fadeOutAndStop] start`);
    await this.fadeOut(durationSec);
    this.stop();
    void this._audioGraph?.fadeTo(this._muted ? 0 : this._volume, 0);
  }
  cancelFade(): void {
    this._audioGraph?.cancelFade();
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
    if (this._stateManager.isDisposed) return;

    this._cancellation?.cancel();
    await this.cleanup();

    if (this._ctx?.state !== "closed") {
      await this._ctx?.close();
    }
    this._ctx = null;

    this._audioGraph?.dispose();
    this._audioGraph = null;
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
    if (!this._currentStrategy) return;

    if (!this._audioGraph) {
      this._audioGraph = new AudioGraph(this.audioContext);
    }

    const sourceNode = this._currentStrategy.connectToGraph(this.audioContext);

    sourceNode.connect(this._audioGraph.input);

    this._audioGraph.output.connect(this.audioContext.destination);
    this._audioGraph.setVolume(this._muted ? 0 : this._volume);
    this._currentStrategy.setVolume(Volume(1));
  }

  private bindStrategyEvents(): void {
    if (!this._currentStrategy) return;

    this._currentStrategy.on("play", () => {
      this.emit("play");
    });

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

    this._currentStrategy?.dispose();
    this._currentStrategy = null;

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
