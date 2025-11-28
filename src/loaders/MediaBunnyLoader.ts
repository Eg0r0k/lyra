import {
  AudioBufferSink,
  BlobSource,
  Input,
  InputAudioTrack,
  ReadableStreamSource,
  ALL_FORMATS,
} from "mediabunny";
import { AudioSource } from "../types/index";
import { ISourceLoader, LoadResult } from "./ISourceLoader";

export class MediaBunnyLoader implements ISourceLoader {
  readonly id = "mediabunny";
  private _aborted = false;
  private _currentInput: Input | null = null;

  canLoad(source: AudioSource): boolean {
    return !!(
      source.data &&
      (source.data instanceof File ||
        source.data instanceof Blob ||
        source.data instanceof ReadableStream)
    );
  }

  async load(
    source: AudioSource,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<LoadResult> {
    if (!ctx) throw new Error("MediaBunnyLoader: AudioContext is required");
    if (!source.data)
      throw new Error("MediaBunnyLoader: Source data is missing");
    if (!ALL_FORMATS || !Array.isArray(ALL_FORMATS)) {
      throw new Error(
        "MediaBunnyLoader: ALL_FORMATS not imported correctly. Check mediabunny version."
      );
    }

    this._aborted = false;

    const onAbort = () => {
      this._aborted = true;
      if (this._currentInput) {
        try {
          this._currentInput.dispose();
        } catch (e) {}
      }
    };
    signal.addEventListener("abort", onAbort);

    try {
      signal.throwIfAborted();

      console.log("[MediaBunny] Creating input...");
      const input = this.createInput(source.data);
      this._currentInput = input;

      this.checkAborted(signal);

      console.log("[MediaBunny] Reading tracks...");
      const tracks = await input.getTracks();
      const audioTrack = tracks.find(
        (t) => t.type === "audio"
      ) as InputAudioTrack;

      if (!audioTrack) {
        throw new Error("No audio track found in media file.");
      }

      this.checkAborted(signal);

      console.log("[MediaBunny] Decoding...");
      const rawBuffer = await this.decodeWithSink(audioTrack, signal);

      this.checkAborted(signal);

      console.log("[MediaBunny] Resampling...");
      const finalBuffer = await this.resampleIfNeeded(rawBuffer, ctx);

      let tags: any = {};
      try {
        tags = await input.getMetadataTags();
      } catch (e) {
        console.warn("[MediaBunny] Failed to extract tags:", e);
      }

      return {
        audioBuffer: finalBuffer,
        duration: finalBuffer.duration,
        metadata: {
          sampleRate: finalBuffer.sampleRate,
          numberOfChannels: finalBuffer.numberOfChannels,
          length: finalBuffer.length,
          title: tags?.title,
          artist: tags?.artist,
          decodedWith: "mediabunny",
        },
      };
    } catch (err: any) {
      if (
        err === this ||
        (typeof err === "object" && err.id === "mediabunny")
      ) {
        throw new Error("MediaBunnyLoader internal context error");
      }

      if (
        this._aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        throw err;
      }

      console.error("[MediaBunny] Error details:", err);

      let message = "Unknown error";
      if (err instanceof Error) message = err.message;
      else if (typeof err === "string") message = err;
      else message = "Decoding failed (non-standard error object)";

      throw new Error(`MediaBunny decoding failed: ${message}`);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this._currentInput) {
        try {
          this._currentInput.dispose();
        } catch (e) {
          /* ignore */
        }
        this._currentInput = null;
      }
    }
  }

  private createInput(data: NonNullable<AudioSource["data"]>): Input {
    let source;
    if (data instanceof File || data instanceof Blob) {
      source = new BlobSource(data);
    } else if (data instanceof ReadableStream) {
      source = new ReadableStreamSource(data as ReadableStream<Uint8Array>);
    } else {
      throw new Error(
        `Unsupported data type: ${Object.prototype.toString.call(data)}`
      );
    }

    return new Input({
      source,
      formats: ALL_FORMATS,
    });
  }

  private async decodeWithSink(
    track: InputAudioTrack,
    signal: AbortSignal
  ): Promise<AudioBuffer> {
    const sink = new AudioBufferSink(track);
    const chunks: AudioBuffer[] = [];

    try {
      for await (const item of sink.buffers()) {
        this.checkAborted(signal);

        const wrapped = item as any;

        if (wrapped instanceof AudioBuffer) {
          chunks.push(wrapped);
        } else if (wrapped && wrapped.audioBuffer instanceof AudioBuffer) {
          chunks.push(wrapped.audioBuffer);
        } else if (wrapped && wrapped.buffer instanceof AudioBuffer) {
          chunks.push(wrapped.buffer);
        } else {
          console.warn("[MediaBunny] Unknown buffer chunk received", wrapped);
        }
      }
    } catch (err) {
      if (
        this._aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        throw err;
      }
      if (chunks.length > 0) {
        console.warn(
          "[MediaBunny] Decoding interrupted but some data recovered:",
          err
        );
      } else {
        throw err;
      }
    }

    if (chunks.length === 0) {
      throw new Error(
        "Decoded 0 audio frames. File might be encrypted, empty, or format unsupported."
      );
    }

    if (chunks.length === 1) return chunks[0];
    return this.mergeBuffers(chunks);
  }

  private mergeBuffers(buffers: AudioBuffer[]): AudioBuffer {
    const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
    const reference = buffers[0];

    const result = new AudioBuffer({
      length: totalLength,
      numberOfChannels: reference.numberOfChannels,
      sampleRate: reference.sampleRate,
    });

    let offset = 0;
    for (const buffer of buffers) {
      for (let channel = 0; channel < result.numberOfChannels; channel++) {
        if (channel < buffer.numberOfChannels) {
          result
            .getChannelData(channel)
            .set(buffer.getChannelData(channel), offset);
        }
      }
      offset += buffer.length;
    }

    return result;
  }

  private async resampleIfNeeded(
    buffer: AudioBuffer,
    ctx: AudioContext
  ): Promise<AudioBuffer> {
    if (buffer.sampleRate === ctx.sampleRate) {
      return buffer;
    }

    const newLength = Math.ceil(buffer.duration * ctx.sampleRate);

    const offlineCtx = new OfflineAudioContext(
      buffer.numberOfChannels,
      newLength,
      ctx.sampleRate
    );

    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    return await offlineCtx.startRendering();
  }

  private checkAborted(signal: AbortSignal): void {
    if (this._aborted || signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  dispose(): void {
    this._aborted = true;
    if (this._currentInput) {
      try {
        this._currentInput.dispose();
      } catch (e) {}
      this._currentInput = null;
    }
  }
}
