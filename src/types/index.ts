import {
  DEFAULT_LOUDNESS_NORMALIZATION_OPTIONS,
  LoudnessNormalizationOptions,
} from "../audio/normalization";
import type { TimeStretchFactory } from "../strategy/ITimeStretchNode";

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
  /** Resume/retry loading after a fatal network error. */
  startLoad(): void;
  /** Stop loading (used before teardown). */
  stopLoad(): void;
  /** Recover from a fatal media (buffer append / decode) error. */
  recoverMediaError(): void;
  /** Swap audio codec, then call recoverMediaError() again, as a second media-error attempt. */
  swapAudioCodec(): void;
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
  /**
   * Inject an existing {@link AudioContext} to share across players (e.g. to
   * stay under iOS context limits or reuse unlock state). When provided, the
   * player uses it as-is (`latencyHint` is ignored) and NEVER closes it on
   * `dispose()` — the caller owns its lifecycle. A closed injected context
   * throws `PLAYBACK_FAILED` on first use.
   */
  audioContext?: AudioContext;
  volume?: number;
  muted?: boolean;
  loop?: boolean;
  playbackRate?: number;
  autoplay?: boolean;
  preload?: "none" | "metadata" | "auto";
  /**
   * Whether the HTML5 element is routed through the Web Audio graph
   * (EQ / analyser / fades / normalization).
   * - `'always'` (default): route and, for cross-origin URLs, set
   *   `crossOrigin="anonymous"` — graph features work out of the box, but
   *   cross-origin media then requires CORS headers.
   * - `'never'`: plain element playback; no graph, no `crossOrigin`, and no
   *   `AudioContext` is created for html5 loads. `player.graph` is `null`.
   *
   * Web Audio (buffer) sources always route regardless of this option.
   */
  webAudioRouting?: "always" | "never";
  /**
   * When `true`, if a routed (crossOrigin) html5 load fails with a media error,
   * retry it once WITHOUT `crossOrigin` and without graph routing (graph
   * disabled for that track). Default `false` — the media error surfaces as-is.
   */
  corsFallback?: boolean;
  /**
   * Preserve pitch when `playbackRate !== 1` (default `true`). Applied live to
   * the html5 element (and to future loads). WebAudio shifts pitch with rate
   * until a time-stretch plugin is provided; see {@link Player.canPreservePitch}.
   */
  preservesPitch?: boolean;
  hlsConfig?: Partial<HLSConfig> & Record<string, unknown>;
  loudnessNormalization?: LoudnessNormalizationOptions;
  Hls?: HlsConstructor;
  /**
   * Inject a time-stretch plugin factory (DI, like {@link PlayerOptions.Hls} —
   * never imported by the library). When provided AND `preservesPitch` is true,
   * the WebAudio strategy plays through the plugin so `playbackRate` changes
   * tempo without shifting pitch; `player.canPreservePitch` then reports `true`
   * in webaudio mode. Absent, WebAudio resamples (pitch shifts with rate).
   */
  timeStretch?: TimeStretchFactory;
}

/**
 * Per-load overrides applied on top of the constructor {@link PlayerOptions}.
 * Lets a mixed playlist resolve routing per track — e.g. CORS-enabled sources
 * play with the graph, non-CORS sources without it (F-02).
 */
export interface LoadOptions {
  /** Override {@link PlayerOptions.webAudioRouting} for this load only. */
  webAudioRouting?: "always" | "never";
  /** Override {@link PlayerOptions.corsFallback} for this load only. */
  corsFallback?: boolean;
}

export type ResolvedPlayerOptions = Required<
  Omit<
    PlayerOptions,
    "Hls" | "loudnessNormalization" | "hlsConfig" | "audioContext" | "timeStretch"
  >
> & {
  hlsConfig: Required<HLSConfig> & Record<string, unknown>;
  loudnessNormalization: Required<LoudnessNormalizationOptions>;
  Hls?: HlsConstructor;
  audioContext?: AudioContext;
  timeStretch?: TimeStretchFactory;
};

export const DEFAULT_OPTIONS: ResolvedPlayerOptions = {
  mode: "auto",
  latencyHint: "interactive",
  volume: 1,
  muted: false,
  loop: false,
  playbackRate: 1,
  autoplay: false,
  preload: "auto",
  webAudioRouting: "always",
  corsFallback: false,
  preservesPitch: true,
  hlsConfig: {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    startLevel: -1,
    autoStartLoad: true,
    enableWorker: true,
    startFragPrefetch: false,
  },
  loudnessNormalization: DEFAULT_LOUDNESS_NORMALIZATION_OPTIONS,
  Hls: undefined,
};
