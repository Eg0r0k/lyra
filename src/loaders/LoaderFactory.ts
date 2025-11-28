import { AudioSource, AudioSourceType, HLSConfig } from "../types/index";
import { BufferLoader } from "./BufferLoader";
import { HLSLoader } from "./HLSLoader";
import { ISourceLoader } from "./ISourceLoader";
import { MediaBunnyLoader } from "./MediaBunnyLoader";
import { NativeLoader } from "./NativeLoader";
import { PlayerError, PlayerErrorCode } from "../types/events";

interface LoaderFactoryOptions {
  hlsConfig?: Partial<HLSConfig>;
}

export class LoaderFactory {
  private _options: LoaderFactoryOptions;

  private hlsLoader?: HLSLoader;
  private mediaBunnyLoader?: MediaBunnyLoader;

  constructor(options: LoaderFactoryOptions = {}) {
    this._options = options;
  }

  detectType(source: AudioSource): AudioSourceType {
    if (source.type) return source.type;

    if (source.url) {
      const url = source.url.toLowerCase();

      if (url.includes(".m3u8") || source.format === "m3u8") {
        return "hls";
      }
      if (url.includes(".mpd") || source.format === "mpd") {
        return "dash";
      }

      const nativeExts = [
        ".mp3",
        ".wav",
        ".ogg",
        ".aac",
        ".m4a",
        ".webm",
        ".flac",
      ];
      if (nativeExts.some((ext) => url.includes(ext))) {
        return "native";
      }

      return "native";
    }

    if (source.data) {
      if (
        source.data instanceof AudioBuffer ||
        source.data instanceof Uint8Array ||
        source.data instanceof ArrayBuffer
      ) {
        return "buffer";
      }

      if (
        source.data instanceof File ||
        source.data instanceof Blob ||
        source.data instanceof ReadableStream
      ) {
        return "mediabunny";
      }
    }

    return "native";
  }

  createLoader(
    source: AudioSource,
    preferredMode?: "html5" | "webaudio"
  ): ISourceLoader {
    const type = this.detectType(source);

    if (type === "mediabunny" && preferredMode === "html5") {
      if (source.data instanceof File || source.data instanceof Blob) {
        return new NativeLoader();
      }
    }

    switch (type) {
      case "hls":
        if (!this.hlsLoader) {
          this.hlsLoader = new HLSLoader(this._options.hlsConfig);
        }
        return this.hlsLoader;

      case "native":
        return new NativeLoader();

      case "mediabunny":
        if (!this.mediaBunnyLoader) {
          this.mediaBunnyLoader = new MediaBunnyLoader();
        }
        return this.mediaBunnyLoader;

      case "buffer":
        return new BufferLoader();

      case "dash":
        throw new PlayerError(
          "DASH not yet supported",
          PlayerErrorCode.LOAD_NOT_SUPPORTED
        );

      default:
        return new NativeLoader();
    }
  }

  recommendStrategy(source: AudioSource): "html5" | "webaudio" {
    const type = this.detectType(source);

    if (type === "hls" || type === "dash") {
      return "html5";
    }

    if (source.url && type === "native") {
      return "html5";
    }

    return "webaudio";
  }

  dispose(): void {
    this.hlsLoader?.dispose();
    this.hlsLoader = undefined;

    this.mediaBunnyLoader?.dispose();
    this.mediaBunnyLoader = undefined;
  }
}
