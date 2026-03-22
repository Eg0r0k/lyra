export type PlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "error"
  | "disposed";

export type PlaybackMode = "html5" | "webaudio" | "auto";

export type AudioFormat =
  | "mp3"
  | "wav"
  | "ogg"
  | "aac"
  | "flac"
  | "opus"
  | "m4a"
  | "webm"
  | "m3u8"
  | "mpd";

export type AudioSourceType = "native" | "hls" | "buffer";

export interface AudioSource {
  url?: string;
  data?: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  format?: AudioFormat;
  type?: AudioSourceType;
  headers?: Record<string, string>;
}

export type AudioSourceInput = string | File | Blob | AudioSource;

export interface QualityLevel {
  index: number;
  bitrate: number;
  label: string;
  codec?: string;
}
export function normalizeSource(input: AudioSourceInput): AudioSource {
  if (typeof input === "string") {
    return { url: input };
  }
  if (input instanceof File || input instanceof Blob) {
    return { data: input };
  }
  return input;
}

export interface HlsConstructor {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: Record<string, string>;
  ErrorTypes: Record<string, string>;
}

export interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(element: HTMLMediaElement): void;
  detachMedia(): void;
  destroy(): void;
  currentLevel: number;
  levels: Array<{ bitrate: number; audioCodec?: string }>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
}

export interface HLSConfig {
  maxBufferLength: number;
  maxMaxBufferLength: number;
  startLevel: number;
  autoStartLoad: boolean;
  enableWorker: boolean;
  startFragPrefetch: boolean;
}

export interface PlayerOptions {
  mode?: PlaybackMode;
  latencyHint?: AudioContextLatencyCategory | number;
  volume?: number;
  muted?: boolean;
  loop?: boolean;
  playbackRate?: number;
  autoplay?: boolean;
  preload?: "none" | "metadata" | "auto";
  hlsConfig?: Partial<HLSConfig>;

  Hls?: HlsConstructor;
}
export const DEFAULT_OPTIONS: Required<Omit<PlayerOptions, "Hls">> & {
  Hls?: HlsConstructor;
} = {
  mode: "auto",
  latencyHint: "interactive",
  volume: 1,
  muted: false,
  loop: false,
  playbackRate: 1,
  autoplay: false,
  preload: "auto",
  hlsConfig: {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    startLevel: -1,
    autoStartLoad: true,
    enableWorker: true,
    startFragPrefetch: false,
  },
  Hls: undefined,
};
