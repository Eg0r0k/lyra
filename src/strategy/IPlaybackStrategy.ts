import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";

/**
 * Events emitted by playback strategies.
 */
export type PlaybackStrategyEvents = {
  play: void;
  pause: void;
  ended: void;
  timeupdate: TimeSeconds;
  seeked: TimeSeconds;
  durationchange: TimeSeconds;
  waiting: void;
  playing: void;
  error: Error;
  canplaythrough: void;
  buffered: void;
};
/**
 * Base contract implemented by all playback strategies.
 */
export interface StrategyInitOptions {
  sourceUrl?: string;
  audioBuffer?: AudioBuffer;
  /**
   * AudioContext for graph routing. Optional: the html5 strategy ignores it,
   * and it is omitted for un-routed html5 loads (webAudioRouting:'never') so no
   * context is created. WebAudioStrategy requires it and throws if absent.
   */
  audioContext?: AudioContext;
  volume: Volume;
  muted: boolean;
  playbackRate: PlaybackRate;
  loop: boolean;
  /** Preserve pitch when playbackRate !== 1 (default true). */
  preservesPitch: boolean;
  preload: "none" | "metadata" | "auto";
  metadata?: Record<string, unknown>;
  requiresCrossOrigin?: boolean;
  /**
   * Per-load abort signal. Aborting it MUST reject {@link IPlaybackStrategy.initialize}
   * with a `DOMException('Aborted', 'AbortError')` and tear down any pending waiters.
   */
  signal: AbortSignal;
}

export interface IPlaybackStrategy {
  /**
   * Unique strategy identifier.
   */
  readonly id: "html5" | "webaudio";

  readonly duration: TimeSeconds;
  readonly isReady: boolean;
  readonly isPlaying: boolean;
  /**
   * Initializes playback resources and media.
   */
  initialize(options: StrategyInitOptions): Promise<void>;

  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(time: TimeSeconds): void;

  getCurrentTime(): TimeSeconds;
  setVolume(volume: Volume): void;
  setMuted(muted: boolean): void;
  setPlaybackRate(rate: PlaybackRate): void;
  setLoop(loop: boolean): void;
  /** Apply pitch-preservation intent to the active source immediately. */
  setPreservesPitch(value: boolean): void;
  /** Whether this strategy can actually preserve pitch on the current engine. */
  readonly canPreservePitch: boolean;
  /**
   * Returns underlying media element if available.
   */
  getMediaElement?(): HTMLMediaElement | null;
  /**
   * Connects strategy output into an AudioNode graph.
   */
  connectToGraph(ctx: AudioContext): AudioNode;
  /**
   * Subscribes to strategy events.
   */
  on<K extends keyof PlaybackStrategyEvents>(
    event: K,
    callback: (data: PlaybackStrategyEvents[K]) => void,
  ): () => void;
  /**
   * Releases all resources and listeners.
   */
  dispose(): void;
}
