import { EventEmitter } from "../core/EventEmitter";
import { ISourceLoader, LoadResult } from "../loaders/ISourceLoader";
import { LoaderFactory } from "../loaders/LoaderFactory";
import { IPlaybackStrategy } from "../strategy/IPlaybackStrategy";
import { PlayerError, PlayerErrorCode, PlayerEventMap } from "../types/events";
import { StateManager } from "./StateManager";
import {
  AudioSource,
  AudioSourceInput,
  AudioSourceType,
  DEFAULT_OPTIONS,
  HLSConfig,
  normalizeSource,
  PlaybackMode,
  PlayerOptions,
  QualityLevel,
} from "../types/index";
import { CancellationError, CancellationToken } from "./CancellationToken";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import { PlayerState } from "../types";
import { HLSLoader } from "../loaders/HLSLoader";
import { HTML5Strategy } from "../strategy/Html5AudioStrategy";
import { WebAudioStrategy } from "../strategy/WebAudioStrategy";
import { AudioGraph } from "../audio/AudioGraph";

export class Player extends EventEmitter<PlayerEventMap> {
  private _ctx: AudioContext | null = null;

  private _stateManager: StateManager;
  private _loaderFactory: LoaderFactory;
  private _audioGraph: AudioGraph | null = null;
  private _currentLoader: ISourceLoader | null = null;
  private _currentStrategy: IPlaybackStrategy | null = null;
  private _currentSource: AudioSource | null = null;
  private _loadResult: LoadResult | null = null;
  private _cancellation: CancellationToken | null = null;

  private _options: Required<PlayerOptions>;
  private _volume: Volume;
  private _muted: boolean;
  private _playbackRate: PlaybackRate;
  private _loop: boolean;

  private _objectUrls: Set<string> = new Set();

  constructor(options: PlayerOptions) {
    super();

    this._options = { ...DEFAULT_OPTIONS, ...options };

    this._stateManager = new StateManager();
    this._loaderFactory = new LoaderFactory({
      hlsConfig: this._options.hlsConfig,
    });

    this._volume = Volume(this._options.volume);
    this._muted = this._options.muted;
    this._playbackRate = PlaybackRate(this._options.playbackRate);
    this._loop = this._options.loop;

    this._stateManager.onChange(({ from, to }) => {
      this.emit("statechange", { from, to });
      console.log(`State: ${from} -> ${to}`);
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
    const normalizedSource = normalizeSource(source);

    if (this._stateManager.isDisposed) {
      throw new PlayerError(
        "Player is disposed",
        PlayerErrorCode.PLAYBACK_FAILED
      );
    }

    this._cancellation?.cancel();
    this._cancellation = new CancellationToken();
    const signal = this._cancellation.signal;

    await this.cleanup();

    this._stateManager.transition("loading");
    this.emit("loadstart");

    try {
      const preferredMode =
        this._options.mode === "auto" ? undefined : this._options.mode;
      this._currentLoader = this._loaderFactory.createLoader(
        normalizedSource,
        preferredMode
      );
      this._currentSource = normalizedSource;

      let strategyType = this.determineStrategy(normalizedSource);

      if (
        this._currentLoader.id === "native" &&
        (normalizedSource.data instanceof File ||
          normalizedSource.data instanceof Blob)
      ) {
        if (preferredMode === "html5") {
          strategyType = "html5";
        }
      }
      if (
        this._currentLoader.id === "mediabunny" ||
        this._currentLoader.id === "buffer"
      ) {
        if (strategyType === "html5") {
          console.warn(
            "Switching to WebAudio strategy because loader produces raw buffer"
          );
        }
        strategyType = "webaudio";
      }

      this._currentStrategy = this.createStrategy(strategyType);

      if (
        this._currentLoader instanceof HLSLoader &&
        this._currentStrategy instanceof HTML5Strategy
      ) {
        this._currentLoader.attachMedia(
          this._currentStrategy.getAudioElement()
        );
      }

      const needsContext = strategyType === "webaudio";
      const ctx = needsContext ? this.audioContext : null;

      this._loadResult = await this._currentLoader.load(
        normalizedSource,
        ctx,
        signal
      );

      signal.throwIfAborted();

      if (this._loadResult.objectUrl) {
        this._objectUrls.add(this._loadResult.objectUrl);
      }
      await this._currentStrategy!.initialize({
        sourceUrl: this._loadResult.sourceUrl,
        audioBuffer: this._loadResult.audioBuffer,
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

      if (this._currentLoader.getQualityLevels) {
        const levels = this._currentLoader.getQualityLevels();
        if (levels.length > 0) {
          this.emit("qualitiesavailable", levels);
        }
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
        PlayerErrorCode.LOAD_DECODE
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
        PlayerErrorCode.PLAYBACK_FAILED
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
        PlayerErrorCode.PLAYBACK_NOT_ALLOWED
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

    this._currentStrategy?.setVolume(this._volume);
    this._audioGraph?.setVolume(this._muted ? 0 : this._volume);

    this.emit("volumechange", {
      volume: this._volume,
      muted: this._muted,
    });
  }

  setMuted(muted: boolean): void {
    this._muted = muted;

    this._currentStrategy?.setMuted(muted);
    this._audioGraph?.setVolume(muted ? 0 : this._volume);

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

  getQualityLevels(): QualityLevel[] {
    return this._currentLoader?.getQualityLevels?.() ?? [];
  }

  setQuality(level: number): void {
    this._currentLoader?.setQuality?.(level);

    const levels = this.getQualityLevels();
    const current = levels[level];
    if (current) {
      this.emit("qualitychange", current);
    }
  }

  getCurrentQuality(): number {
    return this._currentLoader?.getCurrentQuality?.() ?? -1;
  }

  async dispose(): Promise<void> {
    if (this._stateManager.isDisposed) return;

    this._cancellation?.cancel();

    await this.cleanup();

    // Закрываем AudioContext
    if (this._ctx && this._ctx.state !== "closed") {
      await this._ctx.close();
    }
    this._ctx = null;

    // Освобождаем factory
    this._loaderFactory.dispose();

    // Помечаем как disposed
    this._stateManager.dispose();

    this.emit("dispose");
    this.removeAllListeners();
  }

  private determineStrategy(source: AudioSource): "html5" | "webaudio" {
    if (this._options.mode !== "auto") {
      return this._options.mode;
    }

    return this._loaderFactory.recommendStrategy(source);
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

    // Подключаем: source -> graph -> destination
    sourceNode.connect(this._audioGraph.input);
    this._audioGraph.output.connect(this.audioContext.destination);

    // Применяем текущую громкость
    this._audioGraph.setVolume(this._muted ? 0 : this._volume);
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
      const playerError = PlayerError.fromError(error);
      this.emit("error", {
        code: playerError.code,
        message: playerError.message,
        cause: playerError.cause,
      });
    });
  }
  private async cleanup(): Promise<void> {
    if (this._currentStrategy) {
      this._currentStrategy.dispose();
      this._currentStrategy = null;
    }
    if (this._currentLoader instanceof HLSLoader) {
      this._currentLoader.detachMedia();
    }
    if (this._currentLoader && !(this._currentLoader instanceof HLSLoader)) {
      this._currentLoader.dispose();
    }

    this._currentLoader = null;

    for (const url of this._objectUrls) {
      URL.revokeObjectURL(url);
    }
    this._objectUrls.clear();

    this._loadResult = null;
    this._currentSource = null;
    this._stateManager.reset();
  }

  static forMusic(options?: PlayerOptions): Player {
    return new Player({
      mode: "webaudio",
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
