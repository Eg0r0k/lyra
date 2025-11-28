import { PlaybackRate, TimeSeconds, Volume } from "../types/branded";

export type PlaybackStrategyEvents = {
  play: void;
  pause: void;
  ended: void;
  timeupdate: TimeSeconds;
  durationchange: TimeSeconds;
  waiting: void;
  playing: void;
  error: Error;
};

export interface StrategyInitOptions {
  sourceUrl?: string;

  audioBuffer?: AudioBuffer;

  audioContext: AudioContext;

  volume: Volume;

  muted: boolean;

  playbackRate: PlaybackRate;

  loop: boolean;

  preload: "none" | "metadata" | "auto";
}

export interface IPlaybackStrategy {
  readonly id: "html5" | "webaudio";

  readonly duration: TimeSeconds;
  readonly isReady: boolean;
  readonly isPlaying: boolean;

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

  connectToGraph(ctx: AudioContext): AudioNode;

  on<K extends keyof PlaybackStrategyEvents>(
    event: K,
    callback: (data: PlaybackStrategyEvents[K]) => void
  ): () => void;

  dispose(): void;
}
