import {
  IPlaybackStrategy,
  PlaybackStrategyEvents,
  StrategyInitOptions,
} from "./IPlaybackStrategy";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import { EventEmitter } from "../core/EventEmitter";

export class WebAudioStrategy
  extends EventEmitter<PlaybackStrategyEvents>
  implements IPlaybackStrategy
{
  readonly id = "webaudio";

  private _ctx: AudioContext | null = null;
  private _audioBuffer: AudioBuffer | null = null;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _gainNode: GainNode | null = null;

  private _isPlaying = false;
  private _isReady = false;
  private _loop = false;
  private _playbackRate: PlaybackRate = 1 as PlaybackRate;
  private _muted = false;
  private _volume: Volume = 1 as Volume;

  private _startTime = 0;
  private _startOffset = 0;
  private _pausedAt = 0;

  private _rafId: number | null = null;

  constructor() {
    super();
  }

  get duration(): TimeSeconds {
    return TimeSeconds(this._audioBuffer?.duration ?? 0);
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  async initialize(options: StrategyInitOptions): Promise<void> {
    this._ctx = options.audioContext;
    this._volume = options.volume;
    this._muted = options.muted;
    this._playbackRate = options.playbackRate;
    this._loop = options.loop;

    if (options.audioBuffer) {
      this._audioBuffer = options.audioBuffer;
      this._gainNode = this._ctx.createGain();
      this._gainNode.gain.value = this._muted ? 0 : this._volume;
    } else if (options.sourceUrl) {
      throw new Error("WebAudioStrategy requires audioBuffer");
    }
    this._isReady = true;
    this.emit("durationchange", this.duration);
  }

  async play(): Promise<void> {
    if (!this._ctx || !this._audioBuffer || !this._gainNode) {
      throw new Error("WebAudioStrategy not initialized");
    }

    if (this._isPlaying) return;
    this._sourceNode = this._ctx.createBufferSource();
    this._sourceNode.buffer = this._audioBuffer;
    this._sourceNode.loop = this._loop;
    this._sourceNode.playbackRate.value = this._playbackRate;

    // source -> gain
    this._sourceNode.connect(this._gainNode);

    this._sourceNode.onended = () => {
      if (this._isPlaying) {
        this._isPlaying = false;
        this.stopTimeUpdate();

        if (!this._loop) {
          this._pausedAt = 0;
          this.emit("ended");
        }
      }
    };

    const offset = this._pausedAt;
    this._startTime = this._ctx.currentTime;
    this._startOffset = offset;

    this._sourceNode.start(0, offset);
    this._isPlaying = true;

    this.startTimeUpdate();
    this.emit("play");
  }

  pause(): void {
    if (!this._isPlaying || !this._sourceNode || !this._ctx) return;

    this._pausedAt = this.getCurrentTime();

    this._sourceNode.onended = null;
    this._sourceNode.stop();
    this._sourceNode.disconnect();
    this._sourceNode = null;

    this._isPlaying = false;
    this.stopTimeUpdate();
    this.emit("pause");
  }
  stop(): void {
    this.pause();
    this._pausedAt = 0;
  }
  seek(time: TimeSeconds): void {
    const wasPlaying = this._isPlaying;

    if (wasPlaying) {
      this.pause();
    }

    this._pausedAt = Math.max(0, Math.min(time, this.duration));

    if (wasPlaying) {
      this.play();
    }

    this.emit("timeupdate", TimeSeconds(this._pausedAt));
  }

  getCurrentTime(): TimeSeconds {
    if (!this._isPlaying || !this._ctx) {
      return TimeSeconds(this._pausedAt);
    }

    const elapsed =
      (this._ctx.currentTime - this._startTime) * this._playbackRate;
    let current = this._startOffset + elapsed;

    if (this._loop && this._audioBuffer) {
      current = current % this._audioBuffer.duration;
    }

    return TimeSeconds(Math.min(current, this.duration));
  }
  setVolume(volume: Volume): void {
    this._volume = volume;
    if (this._gainNode && !this._muted) {
      this._gainNode.gain.setValueAtTime(volume, this._ctx?.currentTime ?? 0);
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this._gainNode) {
      const value = muted ? 0 : this._volume;
      this._gainNode.gain.setValueAtTime(value, this._ctx?.currentTime ?? 0);
    }
  }

  setPlaybackRate(rate: PlaybackRate): void {
    if (this._isPlaying && this._sourceNode && this._ctx) {
      this._pausedAt = this.getCurrentTime();
      this._startTime = this._ctx.currentTime;
      this._startOffset = this._pausedAt;
    }

    this._playbackRate = rate;

    if (this._sourceNode) {
      this._sourceNode.playbackRate.value = rate;
    }
  }
  setLoop(loop: boolean): void {
    this._loop = loop;
    if (this._sourceNode) {
      this._sourceNode.loop = loop;
    }
  }

  connectToGraph(_ctx: AudioContext): AudioNode {
    if (!this._gainNode) {
      throw new Error("WebAudioStrategy not initialized");
    }
    return this._gainNode;
  }

  private startTimeUpdate(): void {
    const update = () => {
      if (!this._isPlaying) return;

      this.emit("timeupdate", this.getCurrentTime());
      this._rafId = requestAnimationFrame(update);
    };

    this._rafId = requestAnimationFrame(update);
  }

  private stopTimeUpdate(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  on<K extends keyof PlaybackStrategyEvents>(
    event: K,
    callback: (data: PlaybackStrategyEvents[K]) => void
  ): () => void {
    return super.on(event, callback as any);
  }

  dispose(): void {
    this.stop();

    this._gainNode?.disconnect();
    this._gainNode = null;
    this._audioBuffer = null;
    this._ctx = null;
    this._isReady = false;

    this.removeAllListeners();
  }
}
