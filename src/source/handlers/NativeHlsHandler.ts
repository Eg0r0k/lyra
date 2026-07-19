import { IPlaybackStrategy } from "../../strategy/IPlaybackStrategy";
import { AudioSource } from "../../types";
import { PlayerError, PlayerErrorCode } from "../../types/events";
import {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "../ISourceHandler";
import { isHlsSource } from "./hls-source";

/**
 * Native HLS playback for engines that can play `.m3u8` through a plain media
 * element (Safari / iOS via AVFoundation) — the platforms where hls.js is
 * unavailable because there is no MSE.
 *
 * It assigns the playlist URL straight to the HTML5 element (no hls.js, no
 * segment fetching in JS), so it exposes no quality-level API. Registered after
 * {@link HLSHandler} so MSE/hls.js wins when both are available.
 */
export class NativeHlsHandler implements ISourceHandler {
  readonly id = "hls-native";

  /** Cached `canPlayType` probe result (probed once, lazily). */
  private _supportsNativeHls: boolean | null = null;
  /** Media element of the active load — source of isLive + seekable range. */
  private _mediaElement: HTMLMediaElement | null = null;
  /**
   * Stable per-session capabilities object (T-30 / F-52). Built once, reused,
   * dropped on reset(); its `isLive`/seekable getters read the live element.
   */
  private _capabilities: SourceCapabilities | null = null;

  canHandle(source: AudioSource): boolean {
    return isHlsSource(source) && this.supportsNativeHls();
  }

  preferredStrategy(): "html5" | "webaudio" | "any" {
    return "html5";
  }

  requiredStrategy(): "html5" | "webaudio" | undefined {
    return "html5";
  }

  async prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    _ctx: AudioContext | null,
    _signal: AbortSignal,
  ): Promise<PreparedSource> {
    if (!source.url) {
      throw new PlayerError(
        "Native HLS requires a source URL",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    }

    // Retain the element so getCapabilities() can report live/seekable from it.
    this._mediaElement = strategy.getMediaElement?.() ?? null;

    // Plain element src path: the browser's native pipeline handles the playlist.
    return {
      sourceUrl: source.url,
      duration: 0,
    };
  }

  getCapabilities(): SourceCapabilities | null {
    // Stable per-session object (T-30 / F-52). Native HLS exposes no level API,
    // so quality methods are absent; `isLive` is a live getter (the element's
    // duration only becomes Infinity once metadata loads) and reads the current
    // element via `this`. No `ownsMediaErrors`, so the player keeps its HTML5
    // element error handler for native-HLS load failures.
    if (!this._capabilities) {
      const caps: SourceCapabilities = {
        qualityLevels: [],
        getSeekableRange: () => {
          const ranges = this._mediaElement?.seekable;
          if (!ranges || ranges.length === 0) {
            return null;
          }
          return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
        },
      };

      Object.defineProperty(caps, "isLive", {
        enumerable: true,
        get: () => this._mediaElement?.duration === Infinity,
      });

      this._capabilities = caps;
    }

    return this._capabilities;
  }

  reset(): void {
    this._mediaElement = null;
    this._capabilities = null;
  }

  dispose(): void {
    this._mediaElement = null;
    this._capabilities = null;
  }

  private supportsNativeHls(): boolean {
    if (this._supportsNativeHls === null) {
      this._supportsNativeHls = NativeHlsHandler.detectNativeHls();
    }
    return this._supportsNativeHls;
  }

  private static detectNativeHls(): boolean {
    if (typeof document === "undefined") {
      return false;
    }

    try {
      const probe = document.createElement("audio");
      return probe.canPlayType("application/vnd.apple.mpegurl") !== "";
    } catch {
      return false;
    }
  }
}
