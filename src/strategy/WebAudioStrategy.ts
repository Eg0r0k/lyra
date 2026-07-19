import {
  IPlaybackStrategy,
  PlaybackStrategyEvents,
  StrategyInitOptions,
} from "./IPlaybackStrategy";
import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";
import { EventEmitter } from "../core/EventEmitter";
import { PlayerError, PlayerErrorCode } from "../types/events";
import { playerLogger } from "../utils/Logger";
import type { ITimeStretchNode } from "./ITimeStretchNode";

/**
 * Public `timeupdate` cadence (~4/s), aligned with native HTML5 media. Uses a
 * timer (not rAF) so background tabs keep updating — throttled by the browser
 * to >=1 s there, acceptable and better than a frozen rAF (F-28). Position is
 * read from `ctx.currentTime` on demand, so values stay correct at any cadence.
 */
const TIMEUPDATE_INTERVAL_MS = 250;

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
  /**
   * Optional injected time-stretch plugin (T-24). When present, the source
   * plays at rate 1.0 into it and it owns tempo (via setRate) and the
   * position source of truth (via getInputPosition); null = resampling path.
   */
  private _stretcher: ITimeStretchNode | null = null;

  private _isPlaying = false;
  private _isReady = false;
  private _loop = false;
  private _preservesPitch = true;
  /** Ensures the "pitch preservation unavailable" warning logs at most once. */
  private _pitchWarned = false;

  private _playbackRate: PlaybackRate = 1 as PlaybackRate;
  private _muted = false;
  private _volume: Volume = 1 as Volume;

  private _startTime = 0;
  private _startOffset = 0;
  private _pausedAt = 0;

  /** Public timeupdate emitter interval (setInterval id). */
  private _timeUpdateInterval: number | null = null;
  /**
   * True during the internal pause/play restart of {@link WebAudioStrategy.seek}
   * so those transitions don't leak spurious pause/play events (F-22).
   */
  private _seeking = false;
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

    if (options.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

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
    this._preservesPitch = options.preservesPitch;
    this.warnIfPitchUnsupported();

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

      if (options.timeStretch && this._preservesPitch) {
        const ctx = options.audioContext;
        const gain = this._gainNode;

        try {
          this._stretcher = await options.timeStretch(ctx);
        } catch (error) {
          // The plugin is optional: a factory that rejects (worklet module or
          // WASM that failed to load) must degrade to resampling, NOT fail the
          // load (T-24 contract: no new error codes). Warn once so it is not
          // silent; canPreservePitch stays false since no node was attached.
          this._stretcher = null;
          playerLogger.warn(
            "time-stretch plugin factory failed; falling back to resampling " +
              "(pitch shifts with playbackRate)",
            error,
          );
        }

        if (options.signal.aborted) {
          this._stretcher?.dispose();
          this._stretcher = null;
          throw new DOMException("Aborted", "AbortError");
        }

        if (this._stretcher) {
          // source → gain → stretcher → (connectToGraph) → AudioGraph.input, so
          // EQ/analyser act on the pitch-corrected, time-stretched signal (T-24).
          gain?.connect(this._stretcher.node);
          this._stretcher.setRate(this._playbackRate);

          playerLogger.debug(
            "Time-stretch plugin attached",
            `rate=${this._playbackRate}`,
          );
        }
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
      // In stretcher mode the source runs at 1.0 and the plugin owns tempo;
      // otherwise the source's own playbackRate resamples (pitch shifts) (T-24).
      this._sourceNode.playbackRate.value = this._stretcher
        ? 1
        : this._playbackRate;

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

      if (!this._seeking) {
        this.emit("play");
      }

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

    if (!this._seeking) {
      this.emit("pause");
    }
  }

  stop(): void {
    playerLogger.debug("Stopping playback");

    this.pause();

    this._pausedAt = 0;
  }

  seek(time: TimeSeconds): void {
    const wasPlaying = this._isPlaying;

    playerLogger.debug("Seeking", `target=${time}`);

    // Suppress the pause/play events of the internal restart — a seek is not a
    // pause/resume (parity with html5, which never emits them on seek) (F-22).
    this._seeking = true;
    try {
      if (wasPlaying) {
        this.pause();
      }

      this._pausedAt = Math.max(0, Math.min(time, this.duration));

      // Drop the plugin's buffered (already-stretched) audio so it doesn't
      // bleed past the new position after the restart (T-24).
      this._stretcher?.flush();

      if (wasPlaying) {
        this.play().catch((err) => {
          playerLogger.error("Seek replay failed", err);

          this.emit(
            "error",
            err instanceof Error ? err : new Error(String(err)),
          );
        });
      }
    } finally {
      this._seeking = false;
    }

    // WebAudio seek is synchronous → emit seeked now (html5 emits from its
    // native seeked event instead). seeking stays the player's concern.
    this.emit("seeked", TimeSeconds(this._pausedAt));
    this.emit("timeupdate", TimeSeconds(this._pausedAt));
  }

  getCurrentTime(): TimeSeconds {
    if (!this._isPlaying || !this._ctx) {
      return TimeSeconds(this._pausedAt);
    }

    if (this._ctx.state !== "running") {
      return this._lastKnownTime;
    }

    let current: number;

    if (this._stretcher) {
      // Position source of truth in stretcher mode: the source clock runs at
      // 1.0 and doesn't reflect the stretched tempo, so read the plugin (T-24).
      current = this._stretcher.getInputPosition();
    } else {
      const elapsed =
        (this._ctx.currentTime - this._startTime) * this._playbackRate;
      current = this._startOffset + elapsed;
    }

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

    // Resampling advances position via the ctx clock × rate, so a rate change
    // must re-anchor _startTime; stretcher mode reads position from the plugin
    // and keeps the source at 1.0, so that math is bypassed (T-24).
    if (!this._stretcher && this._isPlaying && this._sourceNode && this._ctx) {
      this._pausedAt = this.getCurrentTime();
      this._startTime = this._ctx.currentTime;
      this._startOffset = this._pausedAt;
    }

    this._playbackRate = rate;
    this.warnIfPitchUnsupported();

    if (this._stretcher) {
      this._stretcher.setRate(rate);
    } else if (this._sourceNode) {
      this._sourceNode.playbackRate.value = rate;
    }
  }

  /**
   * WebAudio resampling shifts pitch with rate; true pitch preservation needs a
   * time-stretch node (T-24), which is not wired here. Store the intent and warn
   * once so the divergence is not silent.
   */
  setPreservesPitch(value: boolean): void {
    this._preservesPitch = value;
    this.warnIfPitchUnsupported();
  }

  /**
   * True only when a time-stretch plugin is attached (T-24); plain WebAudio
   * resampling shifts pitch with rate and cannot preserve it.
   */
  get canPreservePitch(): boolean {
    return this._stretcher !== null;
  }

  private warnIfPitchUnsupported(): void {
    // A plugin preserves pitch, so the resampling warning does not apply.
    if (this._stretcher) return;
    if (this._preservesPitch && this._playbackRate !== 1 && !this._pitchWarned) {
      this._pitchWarned = true;
      playerLogger.warn(
        "preservesPitch requested but the WebAudio strategy shifts pitch with " +
          "playbackRate; a time-stretch plugin (T-24) is required for true " +
          "pitch preservation.",
      );
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
   * Returns the strategy's output node for AudioGraph routing: the time-stretch
   * plugin's output when one is attached (so EQ/analyser see the stretched
   * signal), otherwise the gain node (T-24).
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

    return this._stretcher?.node ?? this._gainNode;
  }
  /**
   * Starts the public timeupdate emitter (timer-based, ~4/s). Position is read
   * from `ctx.currentTime` on demand, so background-tab throttling coarsens the
   * cadence but never the values; end-of-track is `onended`-driven, so this
   * cadence does not affect gapless transitions (F-28).
   *
   * @internal
   */
  private startTimeUpdate(): void {
    playerLogger.debug("Starting time update loop");

    this.stopTimeUpdate();
    this._timeUpdateInterval = setInterval(() => {
      if (!this._isPlaying) {
        return;
      }

      this.emit("timeupdate", this.getCurrentTime());
    }, TIMEUPDATE_INTERVAL_MS) as unknown as number;
  }
  /**
   * Stops the public timeupdate emitter.
   *
   * @internal
   */
  private stopTimeUpdate(): void {
    if (this._timeUpdateInterval !== null) {
      playerLogger.debug("Stopping time update loop");

      clearInterval(this._timeUpdateInterval);

      this._timeUpdateInterval = null;
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
    this.stopTimeUpdate();

    this._gainNode?.disconnect();
    this._stretcher?.dispose();
    this._stretcher = null;

    this._gainNode = null;
    this._audioBuffer = null;
    this._ctx = null;

    this._isReady = false;

    this.removeAllListeners();
  }
}
