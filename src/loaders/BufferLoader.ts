import { ISourceLoader, LoadResult } from "./ISourceLoader";
import { AudioSource } from "../types/index";

export class BufferLoader implements ISourceLoader {
  readonly id = "buffer";

  canLoad(source: AudioSource): boolean {
    return !!(
      source.data &&
      (source.data instanceof ArrayBuffer || source.data instanceof Uint8Array)
    );
  }
  async load(
    source: AudioSource,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<LoadResult> {
    let arrayBuffer: ArrayBuffer;

    if (source.data instanceof ArrayBuffer) {
      arrayBuffer = source.data;
    } else if (source.data instanceof Uint8Array) {
      const { buffer, byteOffset, byteLength } = source.data;

      if (
        byteOffset === 0 &&
        byteLength === buffer.byteLength &&
        buffer instanceof ArrayBuffer
      ) {
        arrayBuffer = buffer;
      } else {
        arrayBuffer = (buffer as ArrayBuffer).slice(
          byteOffset,
          byteOffset + byteLength
        );
      }
    } else {
      throw new Error("BufferLoader requires ArrayBuffer or Uint8Array");
    }

    if (!ctx) {
      const blob = new Blob([arrayBuffer]);

      const objectUrl = URL.createObjectURL(blob);

      return {
        sourceUrl: objectUrl,
        objectUrl,
        duration: 0,
      };
    }

    signal.throwIfAborted();

    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return {
      audioBuffer,
      duration: audioBuffer.duration,
    };
  }

  dispose(): void {
    //noop
  }
}
