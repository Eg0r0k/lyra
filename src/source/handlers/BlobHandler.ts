import { IPlaybackStrategy } from "../../strategy/IPlaybackStrategy";
import { AudioSource } from "../../types";
import { PlayerError, PlayerErrorCode } from "../../types/events";
import {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "../ISourceHandler";

export class BlobHandler implements ISourceHandler {
  readonly id = "blob";

  canHandle(source: AudioSource): boolean {
    return source.data instanceof File || source.data instanceof Blob;
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
    const blob = source.data as Blob;

    if (strategy.id === "webaudio" && ctx) {
      const arrayBuffer = await blob.arrayBuffer();
      signal.throwIfAborted();

      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      } catch (err) {
        throw new PlayerError(
          "Failed to decode audio data",
          PlayerErrorCode.LOAD_DECODE,
          err,
        );
      }

      return { audioBuffer, duration: audioBuffer.duration };
    }

    const objectUrl = URL.createObjectURL(blob);
    return {
      sourceUrl: objectUrl,
      objectUrlToRevoke: objectUrl,
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
