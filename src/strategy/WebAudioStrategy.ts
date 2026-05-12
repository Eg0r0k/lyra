import {
  IPlaybackStrategy,
  PlaybackStrategyEvents,
  StrategyInitOptions,
} from "./IPlaybackStrategy";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import { EventEmitter } from "../core/EventEmitter";
import { PlayerError, PlayerErrorCode } from "../types/events";
import { playerLogger } from "../utils/Logger";

/**
 * Web Audio API playback strategy using decoded AudioBuffers.
 *
 * This strategy is optimized for:
 * - precise timing control
 * - DSP/audio effects
 * - waveform processing
 * - seamless graph routing
 * - low-latency playback
 *
 * Unlike {@link HTML5Strategy}, this implementation manually manages
 * playback state using {@link AudioBufferSourceNode} instances.
 *
 * @remarks
 * AudioBufferSourceNode objects are one-shot nodes and cannot be reused
 * after playback finishes or stops. A new source node is created
 * every time playback starts or resumes.
 *
 * @example
 * ```ts
 * const strategy = new WebAudioStrategy();
 *
 * await strategy.initialize({
 *   audioContext,
 *   audioBuffer,
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
  /**
   * Last stable playback position.
   *
   * @remarks
   * Used during AudioContext interruptions or suspensions
   * where currentTime becomes unreliable.
   */
  private _lastKnownTime: TimeSeconds = 0 as TimeSeconds;

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
  /**
   * Initializes decoded audio playback resources.
   *
   * @param options Strategy initialization options.
   *
   * @throws {PlayerError}
   * Thrown if AudioContext or AudioBuffer are missing.
   *
   * @throws {PlayerError}
   * Thrown if internal audio nodes fail to initialize.
   */
  async initialize(options: StrategyInitOptions): Promise<void> {
    playerLogger.debug("Initializing WebAudioStrategy");

    if (!options.audioContext) {
      throw new PlayerError(
        "WebAudioStrategy requires AudioContext",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    this._ctx = options.audioContext;
    this._volume = options.volume;
    this._muted = options.muted;
    this._playbackRate = options.playbackRate;
    this._loop = options.loop;

    if (options.audioBuffer) {
      this._audioBuffer = options.audioBuffer;

      playerLogger.debug(
        "Audio buffer loaded",
        `duration=${this._audioBuffer.duration}s`,
      );

      try {
        this._gainNode = this._ctx.createGain();
        this._gainNode.gain.value = this._muted ? 0 : this._volume;

        playerLogger.debug("Gain node created");
      } catch (error) {
        playerLogger.error("Failed to create audio nodes", error);

        throw new PlayerError(
          `Failed to create audio nodes: ${
            error instanceof Error ? error.message : String(error)
          }`,
          PlayerErrorCode.PLAYBACK_FAILED,
          error,
        );
      }
    } else if (options.sourceUrl) {
      throw new PlayerError(
        "WebAudioStrategy requires audioBuffer, not sourceUrl",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    } else {
      throw new PlayerError(
        "WebAudioStrategy requires audioBuffer",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    }

    this._isReady = true;

    playerLogger.debug("WebAudioStrategy ready");

    this.emit("durationchange", this.duration);
    this.emit("canplaythrough");
  }
  /**
   * Starts or resumes playback.
   *
   * @remarks
   * Creates a new AudioBufferSourceNode internally
   * because source nodes are single-use.
   *
   * @throws {PlayerError}
   * Thrown if playback resources are not initialized.
   *
   * @throws {PlayerError}
   * Thrown when browser autoplay restrictions block playback.
   */
  async play(): Promise<void> {
    if (!this._ctx || !this._audioBuffer || !this._gainNode) {
      throw new PlayerError(
        "WebAudioStrategy not initialized",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    if (this._isPlaying) {
      playerLogger.debug("Play ignored, already playing");
      return;
    }

    try {
      playerLogger.debug(
        "Starting playback",
        `offset=${this._pausedAt}`,
        `rate=${this._playbackRate}`,
      );

      this._sourceNode = this._ctx.createBufferSource();
      this._sourceNode.buffer = this._audioBuffer;
      this._sourceNode.loop = this._loop;
      this._sourceNode.playbackRate.value = this._playbackRate;

      this._sourceNode.connect(this._gainNode);

      this._sourceNode.onended = () => {
        playerLogger.debug("Source node ended");

        if (this._isPlaying) {
          this._isPlaying = false;

          this.stopTimeUpdate();

          if (!this._loop) {
            this._pausedAt = 0;

            playerLogger.debug("Playback finished");

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

      playerLogger.debug("Playback started successfully");
    } catch (error) {
      playerLogger.error("Playback failed", error);

      if (error instanceof DOMException && error.name === "NotAllowedError") {
        throw new PlayerError(
          "Playback not allowed. User interaction required.",
          PlayerErrorCode.PLAYBACK_NOT_ALLOWED,
          error,
        );
      }

      throw new PlayerError(
        `Playback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        PlayerErrorCode.PLAYBACK_FAILED,
        error,
      );
    }
  }

  pause(): void {
    if (!this._isPlaying || !this._sourceNode || !this._ctx) {
      return;
    }

    this._pausedAt = this.getCurrentTime();

    playerLogger.debug("Pausing playback", `time=${this._pausedAt}`);

    this._sourceNode.onended = null;
    this._sourceNode.stop();
    this._sourceNode.disconnect();

    this._sourceNode = null;

    this._isPlaying = false;

    this.stopTimeUpdate();

    this.emit("pause");
  }

  stop(): void {
    playerLogger.debug("Stopping playback");

    this.pause();

    this._pausedAt = 0;
  }

  seek(time: TimeSeconds): void {
    const wasPlaying = this._isPlaying;

    playerLogger.debug("Seeking", `target=${time}`);

    if (wasPlaying) {
      this.pause();
    }

    this._pausedAt = Math.max(0, Math.min(time, this.duration));

    if (wasPlaying) {
      this.play().catch((err) => {
        playerLogger.error("Seek replay failed", err);

        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    }

    this.emit("timeupdate", TimeSeconds(this._pausedAt));
  }

  getCurrentTime(): TimeSeconds {
    if (!this._isPlaying || !this._ctx) {
      return TimeSeconds(this._pausedAt);
    }

    if (this._ctx.state !== "running") {
      return this._lastKnownTime;
    }

    const elapsed =
      (this._ctx.currentTime - this._startTime) * this._playbackRate;

    let current = this._startOffset + elapsed;

    if (this._loop && this._audioBuffer) {
      current = current % this._audioBuffer.duration;
    }

    current = Math.min(current, this.duration);

    this._lastKnownTime = TimeSeconds(current);

    return this._lastKnownTime;
  }

  setVolume(volume: Volume): void {
    this._volume = volume;

    playerLogger.debug("Volume changed", volume);

    if (this._gainNode && !this._muted) {
      this._gainNode.gain.setValueAtTime(volume, this._ctx?.currentTime ?? 0);
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;

    playerLogger.debug("Mute changed", muted);

    if (this._gainNode) {
      const value = muted ? 0 : this._volume;

      this._gainNode.gain.setValueAtTime(value, this._ctx?.currentTime ?? 0);
    }
  }

  setPlaybackRate(rate: PlaybackRate): void {
    playerLogger.debug(
      "Playback rate changed",
      `${this._playbackRate} -> ${rate}`,
    );

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
  /**
   * Resynchronizes internal playback clock after
   * AudioContext resume or interruption recovery.
   *
   * @remarks
   * Prevents playback position drift after
   * suspended/resumed contexts.
   */
  resyncStartTime(): void {
    if (this._ctx && this._isPlaying) {
      playerLogger.debug("Resyncing playback clock after context resume");

      this._startTime = this._ctx.currentTime;
      this._startOffset = this._lastKnownTime;
    }
  }

  setLoop(loop: boolean): void {
    this._loop = loop;

    playerLogger.debug("Loop changed", loop);

    if (this._sourceNode) {
      this._sourceNode.loop = loop;
    }
  }
  /**
   * Returns strategy output node for AudioGraph routing.
   *
   * @returns Gain node connected to playback chain.
   *
   * @throws {PlayerError}
   * Thrown if strategy is not initialized.
   */
  connectToGraph(_ctx: AudioContext): AudioNode {
    if (!this._gainNode) {
      throw new PlayerError(
        "WebAudioStrategy not initialized",
        PlayerErrorCode.PLAYBACK_FAILED,
      );
    }

    playerLogger.debug("Connecting strategy to audio graph");

    return this._gainNode;
  }
  /**
   * Starts requestAnimationFrame playback time updates.
   *
   * @internal
   */
  private startTimeUpdate(): void {
    playerLogger.debug("Starting time update loop");

    const update = () => {
      if (!this._isPlaying) {
        return;
      }

      this.emit("timeupdate", this.getCurrentTime());

      this._rafId = requestAnimationFrame(update);
    };

    this._rafId = requestAnimationFrame(update);
  }
  /**
   * Stops requestAnimationFrame playback updates.
   *
   * @internal
   */
  private stopTimeUpdate(): void {
    if (this._rafId !== null) {
      playerLogger.debug("Stopping time update loop");

      cancelAnimationFrame(this._rafId);

      this._rafId = null;
    }
  }
  /**
   * Releases all playback resources and listeners.
   *
   * @remarks
   * After disposal the strategy instance becomes unusable.
   */
  dispose(): void {
    playerLogger.debug("Disposing WebAudioStrategy");

    this.stop();

    this._gainNode?.disconnect();

    this._gainNode = null;
    this._audioBuffer = null;
    this._ctx = null;

    this._isReady = false;

    this.removeAllListeners();
  }
}
