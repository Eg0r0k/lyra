import { IPlaybackStrategy } from "../../strategy/IPlaybackStrategy";
import { AudioSource } from "../../types";
import { PlayerError, PlayerErrorCode } from "../../types/events";
import {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "../ISourceHandler";

export class BufferHandler implements ISourceHandler {
  readonly id = "buffer";

  canHandle(source: AudioSource): boolean {
    return (
      source.data instanceof ArrayBuffer || source.data instanceof Uint8Array
    );
  }

  preferredStrategy(): "html5" | "webaudio" | "any" {
    return "webaudio";
  }

  async prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<PreparedSource> {
    let arrayBuffer: ArrayBuffer;
    if (source.data instanceof ArrayBuffer) {
      arrayBuffer = source.data;
    } else if (source.data instanceof Uint8Array) {
      const { buffer, byteOffset, byteLength } = source.data;
      arrayBuffer = (buffer as ArrayBuffer).slice(
        byteOffset,
        byteOffset + byteLength
      );
    } else {
      throw new PlayerError(
        "BufferHandler requires ArrayBuffer or Uint8Array",
        PlayerErrorCode.LOAD_NOT_SUPPORTED
      );
    }

    if (ctx) {
      signal.throwIfAborted();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

      return {
        audioBuffer,
        duration: audioBuffer.duration,
      };
    }
    const blob = new Blob([arrayBuffer]);
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
