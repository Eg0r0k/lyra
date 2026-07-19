export { Player } from "./core/Player";
export { EventEmitter } from "./core/EventEmitter";
export { StateManager } from "./core/StateManager";
export { CancellationToken, CancellationError } from "./core/CancellationToken";

export type {
  IPlaybackStrategy,
  StrategyInitOptions,
  PlaybackStrategyEvents,
} from "./strategy/IPlaybackStrategy";
export type {
  ITimeStretchNode,
  TimeStretchFactory,
} from "./strategy/ITimeStretchNode";

export { HTML5Strategy } from "./strategy/Html5AudioStrategy";
export { WebAudioStrategy } from "./strategy/WebAudioStrategy";

export type {
  ISourceHandler,
  PreparedSource,
  SeekableRange,
  SourceCapabilities,
} from "./source/ISourceHandler";

export { SourceManager } from "./source/SourceManager";
export { UrlHandler } from "./source/handlers/UrlHandler";
export { BlobHandler } from "./source/handlers/BlobHandler";
export { BufferHandler } from "./source/handlers/BufferHandler";
export { HLSHandler } from "./source/handlers/HLSHandler";
export { NativeHlsHandler } from "./source/handlers/NativeHlsHandler";

export { AudioGraph } from "./audio/AudioGraph";

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
  LoadOptions,
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
