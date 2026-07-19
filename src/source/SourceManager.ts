import { AudioSource, HLSConfig, HlsConstructor } from "../types";
import { ISourceHandler, SourceCapabilities } from "./ISourceHandler";
import {
  UrlHandler,
  BlobHandler,
  BufferHandler,
  HLSHandler,
  NativeHlsHandler,
} from "./handlers";
import { isHlsSource } from "./handlers/hls-source";
import { PlayerError, PlayerErrorCode } from "../types/events";

export interface SourceManagerOptions {
  hlsConfig?: Partial<HLSConfig> & Record<string, unknown>;
  Hls?: HlsConstructor;
}

export class SourceManager {
  private _handlers: ISourceHandler[] = [];
  private _activeHandler: ISourceHandler | null = null;
  private _options: SourceManagerOptions;
  /**
   * Handlers the manager constructed itself (the built-ins). Only these are
   * disposed by {@link SourceManager.dispose}; externally registered handlers
   * are owned by the caller.
   */
  private readonly _ownedHandlers = new Set<ISourceHandler>();

  constructor(options: SourceManagerOptions = {}) {
    this._options = options;
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers(): void {
    const own = (handler: ISourceHandler): void => {
      this._handlers.push(handler);
      this._ownedHandlers.add(handler);
    };

    if (this._options.Hls && HLSHandler.isSupported(this._options.Hls)) {
      own(new HLSHandler(this._options.hlsConfig, this._options.Hls));
    }

    // Native HLS (Safari/iOS) — after MSE hls.js, before generic handlers.
    own(new NativeHlsHandler());
    // Buffer
    own(new BufferHandler());
    // Blob
    own(new BlobHandler());
    // URL — fallback
    own(new UrlHandler());
  }

  /**
   * Register an externally-owned handler at the front of the chain (highest
   * priority — its `canHandle` is consulted before every built-in, including
   * HLS). The caller retains ownership: it is NOT disposed by
   * {@link SourceManager.dispose}. There is no removal API.
   */
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

    if (isHlsSource(source)) {
      throw new PlayerError(
        "HLS playback is unavailable: no hls.js was injected (use `new Player({ Hls })`) " +
          "and this browser has no native HLS support (Safari/iOS only).",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
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
      // Externally registered handlers are caller-owned — never disposed here,
      // so one handler shared across players survives the first dispose.
      if (this._ownedHandlers.has(handler)) {
        handler.dispose();
      }
    }
    this._handlers = [];
    this._ownedHandlers.clear();
    this._activeHandler = null;
  }
}
