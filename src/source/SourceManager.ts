import { AudioSource, HLSConfig, HlsConstructor } from "../types";
import { ISourceHandler, SourceCapabilities } from "./ISourceHandler";
import { UrlHandler, BlobHandler, BufferHandler, HLSHandler } from "./handlers";
import { PlayerError, PlayerErrorCode } from "../types/events";

export interface SourceManagerOptions {
  hlsConfig?: Partial<HLSConfig>;
  Hls?: HlsConstructor;
}

export class SourceManager {
  private _handlers: ISourceHandler[] = [];
  private _activeHandler: ISourceHandler | null = null;
  private _options: SourceManagerOptions;

  constructor(options: SourceManagerOptions = {}) {
    this._options = options;
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers(): void {
    if (this._options.Hls && HLSHandler.isSupported(this._options.Hls)) {
      this._handlers.push(
        new HLSHandler(this._options.hlsConfig, this._options.Hls),
      );
    } else {
      //noop
    }

    // Buffer
    this._handlers.push(new BufferHandler());

    // Blob
    this._handlers.push(new BlobHandler());

    // URL — fallback
    this._handlers.push(new UrlHandler());
  }

  registerHandler(handler: ISourceHandler): void {
    this._handlers.unshift(handler);
  }

  getHandler(source: AudioSource): ISourceHandler {
    for (const handler of this._handlers) {
      const canHandle = handler.canHandle(source);

      if (canHandle) {
        return handler;
      }
    }

    throw new PlayerError(
      "No handler found for this source type",
      PlayerErrorCode.LOAD_NOT_SUPPORTED,
    );
  }

  recommendStrategy(source: AudioSource): "html5" | "webaudio" {
    try {
      const handler = this.getHandler(source);
      const preferred = handler.preferredStrategy();

      if (preferred !== "any") {
        return preferred;
      }

      if (source.url) {
        return "html5";
      }

      if (
        source.data instanceof ArrayBuffer ||
        source.data instanceof Uint8Array
      ) {
        return "webaudio";
      }

      return "html5";
    } catch {
      return "html5";
    }
  }

  setActiveHandler(handler: ISourceHandler): void {
    this._activeHandler = handler;
  }

  getActiveCapabilities(): SourceCapabilities | null {
    return this._activeHandler?.getCapabilities() ?? null;
  }

  clearActiveHandler(): void {
    this._activeHandler = null;
  }

  dispose(): void {
    for (const handler of this._handlers) {
      handler.dispose();
    }
    this._handlers = [];
    this._activeHandler = null;
  }
}
