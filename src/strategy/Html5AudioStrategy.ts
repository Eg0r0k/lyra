import { EventEmitter } from "../core/EventEmitter";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import {
  IPlaybackStrategy,
  PlaybackStrategyEvents,
  StrategyInitOptions,
} from "./IPlaybackStrategy";
import { PlayerError, PlayerErrorCode } from "../types/events";
import { playerLogger } from "../utils/Logger";

/**
 * HTML5-based playback strategy built on top of the native
 * {@link HTMLAudioElement} API.
 *
 * This strategy is optimized for:
 * - streaming playback
 * - HLS/media element integrations
 * - browser-native buffering
 * - low CPU usage
 *
 * Internally it wraps a single {@link HTMLAudioElement} instance
 * and forwards native media events through the player event system.
 *
 * @remarks
 * Unlike {@link WebAudioStrategy}, this strategy relies on the browser's
 * built-in media pipeline and does not decode audio manually.
 *
 * @example
 * ```ts
 * const strategy = new HTML5Strategy();
 *
 * await strategy.initialize({
 *   sourceUrl: "/music.mp3",
 *   audioContext,
 *   volume: 1,
 *   muted: false,
 *   playbackRate: 1,
 *   loop: false,
 *   preload: "auto",
 * });
 *
 * await strategy.play();
 * ```
 */

export class HTML5Strategy
  extends EventEmitter<PlaybackStrategyEvents>
  implements IPlaybackStrategy
{
  readonly id = "html5";

  private _audio: HTMLAudioElement;
  /**
   * Cached MediaElementAudioSourceNode used for AudioGraph integration.
   *
   * @remarks
   * Can only be created once per media element.
   */
  private _sourceNode: MediaElementAudioSourceNode | null = null;
  private _isReady = false;
  private _wasBuffering = false;

  private _onPlay = () => {
    this.emit("play");
  };
  private _onPause = () => {
    if (!this._audio.ended) {
      this.emit("pause");
    }
  };
  private _onCanPlayThrough = () => {
    this.emit("canplaythrough");
  };
  private _onWaiting = () => {
    this._wasBuffering = true;
    this.emit("waiting");
  };
  private _onPlaying = () => {
    if (this._wasBuffering) {
      this._wasBuffering = false;
      this.emit("buffered");
    }
    this.emit("playing");
  };
  private _onEnded = () => {
    this.emit("ended");
  };
  private _onTimeUpdate = () => {
    this.emit("timeupdate", TimeSeconds(this._audio.currentTime));
  };
  private _onDurationChange = () => {
    this.emit("durationchange", TimeSeconds(this._audio.duration));
  };
  private _onError = () => {
    this.emit("error", this.createMediaError());
  };
  /**
   * Creates a new HTML5 playback strategy instance.
   *
   * @remarks
   * Automatically creates an internal {@link HTMLAudioElement}
   * and binds all required media event listeners.
   */
  constructor() {
    super();
    this._audio = new Audio();
    this.setupEventListeners();
  }

  get duration(): TimeSeconds {
    return TimeSeconds(this._audio.duration || 0);
  }
  get isReady(): boolean {
    return this._isReady;
  }

  get isPlaying(): boolean {
    return !this._audio.paused && !this._audio.ended;
  }

  getMediaElement(): HTMLMediaElement {
    return this._audio;
  }

  /**
   * Initializes media playback and loads the provided source.
   *
   * Supports:
   * - direct source URLs
   * - pre-attached media
   * - external streaming integrations
   *
   * @param options Strategy initialization options.
   *
   * @throws {PlayerError}
   * Thrown when media loading fails.
   *
   * @throws {Error}
   * Thrown when media loading times out.
   */

  async initialize(options: StrategyInitOptions): Promise<void> {
    this._audio.volume = options.volume;
    this._audio.muted = options.muted;
    this._audio.playbackRate = options.playbackRate;
    this._audio.loop = options.loop;
    this._audio.preload = options.preload;

    const preAttachedMedia = options.metadata?.preAttachedMedia === true;

    if (preAttachedMedia) {
      if (this._audio.readyState >= 1) {
        this._isReady = true;
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this._audio.removeEventListener("loadedmetadata", onLoadedMetadata);
          this._audio.removeEventListener("canplay", onCanPlay);
          this._audio.removeEventListener("error", onError);
          clearTimeout(timer);
        };

        const onLoadedMetadata = () => {
          cleanup();
          resolve();
        };

        const onCanPlay = () => {
          cleanup();
          resolve();
        };

        const onError = () => {
          cleanup();
          reject(this.createMediaError());
        };

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timeout waiting for attached media readiness"));
        }, 30_000);

        this._audio.addEventListener("loadedmetadata", onLoadedMetadata, {
          once: true,
        });
        this._audio.addEventListener("canplay", onCanPlay, { once: true });
        this._audio.addEventListener("error", onError, { once: true });
      });

      this._isReady = true;
      return;
    }

    if (options.sourceUrl) {
      if (
        options.requiresCrossOrigin &&
        this.isCrossOrigin(options.sourceUrl)
      ) {
        this._audio.crossOrigin = "anonymous";
      } else {
        this._audio.removeAttribute("crossorigin");
      }
      this._audio.src = options.sourceUrl;

      await new Promise<void>((resolve, reject) => {
        const onCanPlay = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(this.createMediaError());
        };
        const cleanup = () => {
          this._audio.removeEventListener("canplay", onCanPlay);
          this._audio.removeEventListener("error", onError);
        };

        this._audio.addEventListener("canplay", onCanPlay, { once: true });
        this._audio.addEventListener("error", onError, { once: true });
        this._audio.load();
      });

      this._isReady = true;
    } else {
      if (this._audio.readyState >= 1) {
        this._isReady = true;
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this._audio.removeEventListener("loadedmetadata", onMeta);
          this._audio.removeEventListener("canplay", onCanPlay);
          this._audio.removeEventListener("error", onError);
          clearTimeout(timer);
        };

        const onMeta = () => {
          cleanup();
          resolve();
        };

        const onCanPlay = () => {
          cleanup();
          resolve();
        };

        const onError = () => {
          cleanup();
          reject(this.createMediaError());
        };

        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timeout waiting for loadedmetadata"));
        }, 30_000);

        this._audio.addEventListener("loadedmetadata", onMeta, { once: true });
        this._audio.addEventListener("canplay", onCanPlay, { once: true });
        this._audio.addEventListener("error", onError, { once: true });
      });

      this._isReady = true;
    }
  }

  private isCrossOrigin(url: string): boolean {
    try {
      return new URL(url).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  private setupEventListeners(): void {
    this._audio.addEventListener("play", this._onPlay);
    this._audio.addEventListener("pause", this._onPause);
    this._audio.addEventListener("canplaythrough", this._onCanPlayThrough);
    this._audio.addEventListener("waiting", this._onWaiting);
    this._audio.addEventListener("playing", this._onPlaying);
    this._audio.addEventListener("ended", this._onEnded);
    this._audio.addEventListener("timeupdate", this._onTimeUpdate);
    this._audio.addEventListener("durationchange", this._onDurationChange);
  }

  attachErrorHandler(): void {
    this._audio.addEventListener("error", this._onError);
  }

  private createMediaError(): PlayerError {
    const error = this._audio.error;

    if (!error) {
      return new PlayerError(
        "Unknown media error",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return new PlayerError(
          "Media loading aborted",
          PlayerErrorCode.LOAD_ABORTED,
          error,
        );
      case MediaError.MEDIA_ERR_NETWORK:
        return new PlayerError(
          "Network error while loading media",
          PlayerErrorCode.LOAD_NETWORK,
          error,
        );
      case MediaError.MEDIA_ERR_DECODE:
        return new PlayerError(
          "Media decoding error",
          PlayerErrorCode.LOAD_DECODE,
          error,
        );
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return new PlayerError(
          "Media format not supported",
          PlayerErrorCode.LOAD_NOT_SUPPORTED,
          error,
        );
      default:
        return new PlayerError(
          error.message || "Unknown media error",
          PlayerErrorCode.PLAYBACK_FAILED,
          error,
        );
    }
  }
  /**
   * Starts or resumes playback.
   *
   * @throws {DOMException}
   * Browser playback restrictions may reject playback
   * if user interaction has not occurred yet.
   */
  async play(): Promise<void> {
    await this._audio.play();
  }

  pause(): void {
    this._audio.pause();
  }

  stop(): void {
    this._audio.pause();
    this._audio.currentTime = 0;
  }

  seek(time: TimeSeconds): void {
    this._audio.currentTime = time;
  }

  getCurrentTime(): TimeSeconds {
    return TimeSeconds(this._audio.currentTime);
  }

  setVolume(volume: Volume): void {
    this._audio.volume = volume;
  }

  setMuted(muted: boolean): void {
    this._audio.muted = muted;
  }

  setPlaybackRate(rate: PlaybackRate): void {
    this._audio.playbackRate = rate;
  }

  setLoop(loop: boolean): void {
    this._audio.loop = loop;
  }
  /**
   * Connects media element output into WebAudio graph.
   *
   * @remarks
   * MediaElementAudioSourceNode can only be created once
   * per HTMLMediaElement instance.
   *
   * @param ctx Audio context used for graph integration.
   *
   * @returns Connected audio node.
   */
  connectToGraph(ctx: AudioContext): AudioNode {
    if (!this._sourceNode) {
      this._sourceNode = ctx.createMediaElementSource(this._audio);
    }
    return this._sourceNode;
  }
  getAudioElement(): HTMLAudioElement {
    return this._audio;
  }
  /**
   * Releases all resources, listeners and media references.
   *
   * After calling dispose the strategy becomes unusable.
   */
  dispose(): void {
    playerLogger.debug("HTML5Strategy dispose");
    this._audio.pause();
    this._audio.src = "";
    this._audio.load();
    this._audio.removeEventListener("play", this._onPlay);
    this._audio.removeEventListener("pause", this._onPause);
    this._audio.removeEventListener("canplaythrough", this._onCanPlayThrough);
    this._audio.removeEventListener("waiting", this._onWaiting);
    this._audio.removeEventListener("playing", this._onPlaying);
    this._audio.removeEventListener("ended", this._onEnded);
    this._audio.removeEventListener("timeupdate", this._onTimeUpdate);
    this._audio.removeEventListener("durationchange", this._onDurationChange);
    this._audio.removeEventListener("error", this._onError);
    this._sourceNode = null;
    this._isReady = false;
    this.removeAllListeners();
  }
}
