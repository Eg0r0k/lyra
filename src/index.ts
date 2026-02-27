// ============ Core ============
export { Player } from "./core/Player";
export { EventEmitter } from "./core/EventEmitter";
export { StateManager } from "./core/StateManager";
export { CancellationToken, CancellationError } from "./core/CancellationToken";

// ============ Playback ============
// Types
export type {
  IPlaybackStrategy,
  StrategyInitOptions,
  PlaybackStrategyEvents,
} from "./strategy/IPlaybackStrategy";

// Classes
export { HTML5Strategy } from "./strategy/Html5AudioStrategy";
export { WebAudioStrategy } from "./strategy/WebAudioStrategy";

// ============ Source Handlers ============
// Types
export type {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "./source/ISourceHandler";

// Classes
export { SourceManager } from "./source/SourceManager";
export { UrlHandler } from "./source/handlers/UrlHandler";
export { BlobHandler } from "./source/handlers/BlobHandler";
export { BufferHandler } from "./source/handlers/BufferHandler";
export { HLSHandler } from "./source/handlers/HLSHandler";

// ============ Audio ============
export { AudioGraph } from "./audio/AudioGraph";

// ============ Types ============
export type {
  PlayerState,
  PlaybackMode,
  AudioFormat,
  AudioSourceType,
  AudioSource,
  AudioSourceInput,
  QualityLevel,
  HLSConfig,
  PlayerOptions,
} from "./types";

export { normalizeSource, DEFAULT_OPTIONS } from "./types";

export type { Volume, TimeSeconds, PlaybackRate } from "./types/branded";
export {
  Volume as createVolume,
  TimeSeconds as createTimeSeconds,
  PlaybackRate as createPlaybackRate,
} from "./types/branded";

export type {
  TimeUpdatePayload,
  VolumeChangePayload,
  BufferPayload,
  ErrorPayload,
  PlayerEventMap,
  PlayerEventName,
} from "./types/events";

export { PlayerErrorCode, PlayerError } from "./types/events";
