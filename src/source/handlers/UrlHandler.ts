import { IPlaybackStrategy } from "../../strategy/IPlaybackStrategy";
import { AudioSource } from "../../types";
import { PlayerError, PlayerErrorCode } from "../../types/events";
import {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "../ISourceHandler";
export class UrlHandler implements ISourceHandler {
  readonly id = "url";

  canHandle(source: AudioSource): boolean {
    // Должен быть URL
    if (!source.url) {
      console.log("[UrlHandler] canHandle: no url");
      return false;
    }

    const url = source.url.toLowerCase();

    if (url.includes(".m3u8") || url.includes(".mpd")) {
      console.log("[UrlHandler] canHandle: HLS/DASH url, skipping");
      return false;
    }

    if (source.type === "hls" || source.type === "dash") {
      console.log("[UrlHandler] canHandle: HLS/DASH type, skipping");
      return false;
    }

    console.log("[UrlHandler] canHandle: yes");
    return true;
  }
  preferredStrategy(): "html5" | "webaudio" | "any" {
    return "any";
  }

  async prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<PreparedSource> {
    const url = source.url!;

    console.log("[UrlHandler] prepare:", { url, strategy: strategy.id });

    // Для WebAudio — загружаем и декодируем
    if (strategy.id === "webaudio" && ctx) {
      console.log("[UrlHandler] fetching for WebAudio...");

      const response = await fetch(url, {
        signal,
        headers: source.headers,
        mode: "cors",
      });

      if (!response.ok) {
        throw new PlayerError(
          `HTTP ${response.status}: ${response.statusText}`,
          PlayerErrorCode.LOAD_NETWORK
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      signal.throwIfAborted();

      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      return {
        audioBuffer,
        duration: audioBuffer.duration,
      };
    }

    console.log("[UrlHandler] returning URL for HTML5");
    return {
      sourceUrl: url,
      duration: 0,
    };
  }
  getCapabilities(): SourceCapabilities | null {
    return null;
  }
  dispose(): void {
    //noop
  }
}
