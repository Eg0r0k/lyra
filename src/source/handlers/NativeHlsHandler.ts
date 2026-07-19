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
    _strategy: IPlaybackStrategy,
    _ctx: AudioContext | null,
    _signal: AbortSignal,
  ): Promise<PreparedSource> {
    if (!source.url) {
      throw new PlayerError(
        "Native HLS requires a source URL",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    }

    // Plain element src path: the browser's native pipeline handles the playlist.
    return {
      sourceUrl: source.url,
      duration: 0,
    };
  }

  getCapabilities(): SourceCapabilities | null {
    // Native HLS exposes no level API; quality methods are intentionally absent.
    return {
      qualityLevels: [],
      isLive: false,
    };
  }

  dispose(): void {
    // noop — no per-load session state.
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
