import { AudioSource, HLSConfig } from "../types";
import { ISourceHandler, SourceCapabilities } from "./ISourceHandler";
import { UrlHandler, BlobHandler, BufferHandler, HLSHandler } from "./handlers";
import { PlayerError, PlayerErrorCode } from "../types/events";

export interface SourceManagerOptions {
  hlsConfig?: Partial<HLSConfig>;
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
    // Порядок важен — первый подходящий будет использован

    // HLS — добавим в следующем коммите (опционально)
    if (HLSHandler.isSupported()) {
      this._handlers.push(new HLSHandler(this._options.hlsConfig));
    }

    // Buffer — для ArrayBuffer/Uint8Array
    this._handlers.push(new BufferHandler());

    // Blob — для File/Blob
    this._handlers.push(new BlobHandler());

    // URL — fallback для обычных URL
    this._handlers.push(new UrlHandler());
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
    for (const handler of this._handlers) {
      if (handler.canHandle(source)) {
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
