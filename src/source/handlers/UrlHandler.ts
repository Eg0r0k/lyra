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
    if (!source.url) return false;
    const url = source.url.toLowerCase();
    if (url.includes(".m3u8") || url.includes(".mpd")) {
      return false;
    }
    if (source.type === "hls" || source.type === "dash") {
      return false;
    }
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
    if (strategy.id === "webaudio" && ctx) {
      const response = await fetch(url, {
        signal,
        headers: source.headers,
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
