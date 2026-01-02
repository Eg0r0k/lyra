import { AudioSource, HLSConfig, HlsConstructor } from "../types";
import { ISourceHandler, SourceCapabilities } from "./ISourceHandler";
import { UrlHandler, BlobHandler, BufferHandler, HLSHandler } from "./handlers";
import { PlayerError, PlayerErrorCode } from "../types/events";

export interface SourceManagerOptions {
  hlsConfig?: Partial<HLSConfig>;
  Hls?: HlsConstructor;
}

/**
 * Управляет обработчиками источников.
 * Выбирает подходящий handler для каждого типа источника.
 */
export class SourceManager {
  private _handlers: ISourceHandler[] = [];
  private _activeHandler: ISourceHandler | null = null;
  private _options: SourceManagerOptions;

  constructor(options: SourceManagerOptions = {}) {
    this._options = options;
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers(): void {
    // HLS — если передали Hls класс
    if (this._options.Hls && HLSHandler.isSupported(this._options.Hls)) {
      console.log("[SourceManager] HLS handler registered");
      this._handlers.push(
        new HLSHandler(this._options.hlsConfig, this._options.Hls)
      );
    } else {
      console.log("[SourceManager] HLS not available (Hls class not provided)");
    }

    // Buffer
    this._handlers.push(new BufferHandler());

    // Blob
    this._handlers.push(new BlobHandler());

    // URL — fallback
    this._handlers.push(new UrlHandler());

    console.log(
      "[SourceManager] Registered handlers:",
      this._handlers.map((h) => h.id)
    );
  }
  /**
   * Регистрирует кастомный handler (добавляется в начало списка)
   */
  registerHandler(handler: ISourceHandler): void {
    this._handlers.unshift(handler);
  }

  /**
   * Находит подходящий обработчик для источника
   */

  getHandler(source: AudioSource): ISourceHandler {
    console.log("[SourceManager] Looking for handler for:", source);

    for (const handler of this._handlers) {
      const canHandle = handler.canHandle(source);
      console.log(`[SourceManager] ${handler.id}.canHandle:`, canHandle);

      if (canHandle) {
        return handler;
      }
    }

    throw new PlayerError(
      "No handler found for this source type",
      PlayerErrorCode.LOAD_NOT_SUPPORTED
    );
  }
  /**
   * Определяет рекомендуемую стратегию для источника
   */
  recommendStrategy(source: AudioSource): "html5" | "webaudio" {
    try {
      const handler = this.getHandler(source);
      const preferred = handler.preferredStrategy();

      if (preferred !== "any") {
        return preferred;
      }

      // Для "any" — эвристика
      if (source.url) {
        return "html5"; // URL лучше через HTML5 (не грузим весь файл)
      }

      if (
        source.data instanceof ArrayBuffer ||
        source.data instanceof Uint8Array
      ) {
        return "webaudio"; // Буферы лучше через WebAudio
      }

      return "html5"; // Default
    } catch {
      return "html5";
    }
  }

  /**
   * Устанавливает активный обработчик
   */
  setActiveHandler(handler: ISourceHandler): void {
    this._activeHandler = handler;
  }

  /**
   * Получить capabilities активного обработчика
   */
  getActiveCapabilities(): SourceCapabilities | null {
    return this._activeHandler?.getCapabilities() ?? null;
  }

  /**
   * Очистка активного обработчика (при смене трека)
   */
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
