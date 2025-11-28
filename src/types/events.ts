import { PlayerState, QualityLevel } from ".";
import { PlaybackRate, TimeSeconds, Volume } from "./branded";

export interface TimeUpdatePayload {
  currentTime: TimeSeconds;
  duration: TimeSeconds;
  progress: number;
}

export interface VolumeChangePayload {
  volume: Volume;
  muted: boolean;
}

export interface BufferPayload {
  buffered: TimeRanges;
  percent: number;
}
export interface ErrorPayload {
  code: PlayerErrorCode;
  message: string;
  cause?: unknown;
}
export interface PlayerEventMap {
  // Lifecycle
  loadstart: void;
  loadedmetadata: { duration: TimeSeconds };
  canplay: void;
  canplaythrough: void;

  // Playback
  play: void;
  playing: void;
  pause: void;
  ended: void;
  stop: void;

  // Time
  timeupdate: TimeUpdatePayload;
  durationchange: TimeSeconds;
  seeking: TimeSeconds;
  seeked: TimeSeconds;

  // Buffering
  progress: BufferPayload;
  waiting: void; // Buffering started
  buffered: void; // Buffering ended

  statechange: { from: PlayerState; to: PlayerState };

  volumechange: VolumeChangePayload;
  ratechange: PlaybackRate;

  qualitiesavailable: QualityLevel[];
  qualitychange: QualityLevel;

  error: ErrorPayload;

  dispose: void;
}

export type PlayerEventName = keyof PlayerEventMap;

export enum PlayerErrorCode {
  // Loading
  LOAD_ABORTED = "LOAD_ABORTED",
  LOAD_NETWORK = "LOAD_NETWORK",
  LOAD_DECODE = "LOAD_DECODE",
  LOAD_NOT_SUPPORTED = "LOAD_NOT_SUPPORTED",

  // Playback
  PLAYBACK_NOT_ALLOWED = "PLAYBACK_NOT_ALLOWED",
  PLAYBACK_FAILED = "PLAYBACK_FAILED",

  // HLS
  HLS_FATAL = "HLS_FATAL",
  HLS_NETWORK = "HLS_NETWORK",
  HLS_MEDIA = "HLS_MEDIA",

  // General
  UNKNOWN = "UNKNOWN",
}

export class PlayerError extends Error {
  constructor(
    message: string,
    public readonly code: PlayerErrorCode = PlayerErrorCode.UNKNOWN,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PlayerError";
    if (typeof (Error as any).captureStackTrace === "function") {
      (Error as any).captureStackTrace(this, PlayerError);
    }
  }

  static fromError(error: unknown, code?: PlayerErrorCode): PlayerError {
    if (error instanceof PlayerError) {
      return error;
    }

    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.message === "Aborted")
    ) {
      return new PlayerError(
        "Loading aborted",
        PlayerErrorCode.LOAD_ABORTED,
        error
      );
    }

    let message = "Unknown Error";

    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === "string") {
      message = error;
    } else if (typeof error === "object" && error !== null) {
      if ("message" in error) {
        message = String((error as any).message);
      } else {
        try {
          const json = JSON.stringify(error);
          message = json === "{}" ? String(error) : json;
        } catch {
          message = String(error);
        }
      }
    }

    return new PlayerError(message, code || PlayerErrorCode.UNKNOWN, error);
  }
}
