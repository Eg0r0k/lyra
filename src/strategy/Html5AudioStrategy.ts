import { EventEmitter } from "../core/EventEmitter";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import {
  IPlaybackStrategy,
  PlaybackStrategyEvents,
  StrategyInitOptions,
} from "./IPlaybackStrategy";

export class HTML5Strategy
  extends EventEmitter<PlaybackStrategyEvents>
  implements IPlaybackStrategy
{
  readonly id = "html5";

  private _audio: HTMLAudioElement;
  private _sourceNode: MediaElementAudioSourceNode | null = null;
  private _isReady = false;
  private _wasBuffering = false;

  constructor() {
    super();
    this._audio = new Audio();
    this._audio.crossOrigin = "anonymous";
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
  async initialize(options: StrategyInitOptions): Promise<void> {
    this._audio.volume = options.volume;
    this._audio.muted = options.muted;
    this._audio.playbackRate = options.playbackRate;
    this._audio.loop = options.loop;
    this._audio.preload = options.preload;

    if (options.sourceUrl) {
      this._audio.src = options.sourceUrl;

      await new Promise<void>((resolve, reject) => {
        const onCanPlay = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(this.getMediaErrorMessage()));
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
          this._audio.removeEventListener("error", onError);
          clearTimeout(timer);
        };
        const onMeta = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(this.getMediaErrorMessage()));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timeout waiting for loadedmetadata"));
        }, 30_000);

        this._audio.addEventListener("loadedmetadata", onMeta, { once: true });
        this._audio.addEventListener("error", onError, { once: true });
      });
      this._isReady = true;
    }
  }
  private setupEventListeners(): void {
    this._audio.addEventListener("play", () => {
      this.emit("play");
    });

    this._audio.addEventListener("pause", () => {
      if (!this._audio.ended) {
        this.emit("pause");
      }
    });

    this._audio.addEventListener("canplaythrough", () => {
      this.emit("canplaythrough");
    });

    this._audio.addEventListener("waiting", () => {
      this._wasBuffering = true;
      this.emit("waiting");
    });

    this._audio.addEventListener("playing", () => {
      if (this._wasBuffering) {
        this._wasBuffering = false;
        this.emit("buffered");
      }
      this.emit("playing");
    });

    this._audio.addEventListener("ended", () => {
      this.emit("ended");
    });

    this._audio.addEventListener("timeupdate", () => {
      this.emit("timeupdate", TimeSeconds(this._audio.currentTime));
    });

    this._audio.addEventListener("durationchange", () => {
      this.emit("durationchange", TimeSeconds(this._audio.duration));
    });
  }

  attachErrorHandler(): void {
    this._audio.addEventListener("error", () => {
      this.emit("error", new Error(this.getMediaErrorMessage()));
    });
  }

  private getMediaErrorMessage(): string {
    const error = this._audio.error;
    if (!error) return "Unknown media error";

    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return "Media loading aborted";
      case MediaError.MEDIA_ERR_NETWORK:
        return "Network error while loading media";
      case MediaError.MEDIA_ERR_DECODE:
        return "Media decoding error";
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return "Media format not supported";
      default:
        return error.message || "Unknown media error";
    }
  }

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
  connectToGraph(ctx: AudioContext): AudioNode {
    if (!this._sourceNode) {
      this._sourceNode = ctx.createMediaElementSource(this._audio);
    }
    return this._sourceNode;
  }
  getAudioElement(): HTMLAudioElement {
    return this._audio;
  }

  dispose(): void {
    this._audio.pause();
    this._audio.src = "";
    this._audio.load();
    this._sourceNode = null;
    this._isReady = false;
    this.removeAllListeners();
  }
}
