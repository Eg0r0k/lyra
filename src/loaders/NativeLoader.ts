import { AudioSource } from "../types/index";
import { ISourceLoader, LoadResult } from "./ISourceLoader";

export class NativeLoader implements ISourceLoader {
  readonly id = "native";

  canLoad(source: AudioSource): boolean {
    return (
      !!source.url || source.data instanceof File || source.data instanceof Blob
    );
  }

  async load(
    source: AudioSource,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<LoadResult> {
    if (source.data instanceof File || source.data instanceof Blob) {
      const objectUrl = URL.createObjectURL(source.data);
      return {
        sourceUrl: objectUrl,
        objectUrl: objectUrl,
        duration: 0,
      };
    }

    const url = source.url!;

    if (!ctx) {
      return {
        sourceUrl: url,
        duration: 0,
      };
    }

    const response = await fetch(url, {
      signal,
      headers: source.headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    signal.throwIfAborted();

    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    return {
      audioBuffer,
      duration: audioBuffer.duration,
    };
  }

  dispose(): void {
    // noop
  }
}
