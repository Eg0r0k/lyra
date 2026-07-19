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
  /**
   * Absolute position (seconds) that the plugin's relative input counter is
   * measured from in stretcher mode (T-28). `currentTime = _stretchBaseSec +
   * stretcher.getInputPosition()`. Rebased (and the counter flushed) on every
   * seek and resume-from-pause; the strategy owns this truth, not the plugin.
   */
  private _stretchBaseSec = 0;
  /**
   * Last position returned in stretcher mode, for the monotonicity guard: a
   * stale/late worklet report must not make `currentTime` jump backward within
   * a rebase epoch (T-28). Reset to the new base on every rebase.
   */
  private _lastStretchPos = 0;

  /** Public timeupdate emitter interval (setInterval id). */
  private _timeUpdateInterval: number | null = null;
  /**
   * True during the internal pause/play restart of {@link WebAudioStrategy.seek}
   * so those transitions don't leak spurious pause/play events (F-22).
   */
  private _seeking = false;
  /**
   * True during {@link WebAudioStrategy.stop} so the internal pause() does not
   * leak a spurious `pause` event — stop is not a user pause (F-51).
   */
  private _stopping = false;
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

      if (this._stretcher) {
        // T-28: the source restarts feeding from `offset`, so rebase the
        // absolute position there and flush the plugin — resetting its relative
        // counter to 0 and dropping the stale (already-stretched) latency tail
        // so it can't bleed past the resume/seek point.
        this._stretchBaseSec = offset;
        this._lastStretchPos = offset;
        this._stretcher.flush();
      }

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

    if (!this._seeking && !this._stopping) {
      this.emit("pause");
    }
  }

  stop(): void {
    playerLogger.debug("Stopping playback");

    this._stopping = true;
    try {
      this.pause();
      this._pausedAt = 0;
    } finally {
      this._stopping = false;
    }
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

      if (this._stretcher) {
        // T-28: rebase the absolute position to the seek target and flush — the
        // plugin's relative counter resets to 0 and its already-stretched buffer
        // is dropped so it can't bleed past the new position. Covers a seek
        // while paused (no play() follows); a seek while playing re-applies the
        // same base in play() below.
        this._stretchBaseSec = this._pausedAt;
        this._lastStretchPos = this._pausedAt;
        this._stretcher.flush();
      }

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
      // T-28: the plugin is a RELATIVE input-consumption meter (reset by
      // flush()); the absolute position is _stretchBaseSec + its reading. Guard
      // against a stale/late worklet report dragging the position backward
      // within a rebase epoch (skipped while looping, where wrap is expected).
      const raw = this._stretchBaseSec + this._stretcher.getInputPosition();
      current = this._loop ? raw : Math.max(raw, this._lastStretchPos);
      this._lastStretchPos = current;
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
   * Resynchronizes the internal playback clock after an AudioContext resume or
   * interruption recovery, preventing position drift on the resampling path.
   *
   * @remarks
   * No-op in stretcher mode (T-28): position there is `_stretchBaseSec + the
   * plugin's relative counter`, and the counter cannot advance while the
   * context is suspended (no input is consumed), so it needs no re-anchor.
   */
  resyncStartTime(): void {
    if (this._stretcher) {
      playerLogger.debug("resyncStartTime: no-op in stretcher mode");
      return;
    }

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

    // Detach listeners BEFORE tearing down so a load()-during-playback disposal
    // never relays a stale pause/ended from the old strategy (F-51).
    this.removeAllListeners();

    this.stop();
    this.stopTimeUpdate();

    this._gainNode?.disconnect();
    this._stretcher?.dispose();
    this._stretcher = null;

    this._gainNode = null;
    this._audioBuffer = null;
    this._ctx = null;

    this._isReady = false;
  }
}
