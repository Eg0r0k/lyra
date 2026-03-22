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
    if (!source.url) {
      return false;
    }

    const url = source.url.toLowerCase();

    if (url.includes(".m3u8") || url.includes(".mpd")) {
      return false;
    }

    if (source.type === "hls") {
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
    signal: AbortSignal,
  ): Promise<PreparedSource> {
    const url = source.url!;

    if (strategy.id === "webaudio" && ctx) {
      const response = await fetch(url, {
        signal,
        headers: source.headers,
        mode: "cors",
      });

      if (!response.ok) {
        throw new PlayerError(
          `HTTP ${response.status}: ${response.statusText}`,
          PlayerErrorCode.LOAD_NETWORK,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      signal.throwIfAborted();

      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      } catch (err) {
        throw new PlayerError(
          "Failed to decode audio data",
          PlayerErrorCode.LOAD_DECODE,
          err,
        );
      }

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
