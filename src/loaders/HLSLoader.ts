import {
  AudioSource,
  DEFAULT_OPTIONS,
  HLSConfig,
  QualityLevel,
} from "../types/index";
import Hls from "hls.js";
import { ISourceLoader, LoadResult } from "./ISourceLoader";

export class HLSLoader implements ISourceLoader {
  readonly id = "hls";

  private _hls: Hls | null = null;
  private _config: Partial<HLSConfig>;

  private _attachedElement: HTMLAudioElement | null = null;

  private _qualityLevels: QualityLevel[] = [];
  private _resolveLoad?: (result: LoadResult) => void;
  private _rejectLoad?: (error: Error) => void;

  private _isManifestParsed = false;
  private _isMediaAttached = false;
  constructor(config?: Partial<HLSConfig>) {
    this._config = config ?? DEFAULT_OPTIONS.hlsConfig;
  }

  static isSupported(): boolean {
    return Hls.isSupported();
  }

  canLoad(source: AudioSource): boolean {
    if (!HLSLoader.isSupported()) return false;

    const url = source.url?.toLowerCase() ?? "";
    return (
      url.includes(".m3u8") || source.format === "m3u8" || source.type === "hls"
    );
  }
  private initHls(): void {
    if (this._hls) return;

    this._hls = new Hls({
      maxBufferLength: this._config.maxBufferLength,
      maxMaxBufferLength: this._config.maxMaxBufferLength,
      startLevel: this._config.startLevel ?? -1,
      autoStartLoad: this._config.autoStartLoad ?? true,
      enableWorker: this._config.enableWorker ?? true,
    });
    this.setupEvents();
  }
  async load(
    source: AudioSource,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<LoadResult> {
    const url = source.url!;
    console.log(`[HLS] Loading source: ${url}`);

    // Важно: не вызываем this.cleanup() если инстанс уже создан в attachMedia,
    // иначе мы убьем привязку к медиа элементу.
    if (this._hls && this._attachedElement) {
      console.log("[HLS] Reusing existing Hls instance from attachMedia");
    } else {
      this.cleanup();
      this.initHls();
    }

    if (!this._hls) throw new Error("Failed to initialize HLS");

    console.log("[HLS] Calling hls.loadSource()");
    this._hls.loadSource(url);

    signal.addEventListener("abort", () => {
      console.log("[HLS] Load aborted by signal");
      this._rejectLoad?.(new DOMException("Aborted", "AbortError"));
      this.cleanup();
    });

    return new Promise<LoadResult>((resolve, reject) => {
      this._resolveLoad = resolve;
      this._rejectLoad = reject;
      // Проверяем сразу, вдруг всё готово
      this.checkReady("load");
    });
  }

  private setupEvents(): void {
    if (!this._hls) return;

    this._hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      console.log("[HLS] Manifest parsed");
      this._isManifestParsed = true;
      this._qualityLevels = data.levels.map((level, index) => ({
        index,
        bitrate: level.bitrate,
        label: this.formatBitrate(level.bitrate),
        codec: level.audioCodec,
      }));
      this.checkReady("MANIFEST_PARSED");
    });

    this._hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      console.log("[HLS] Media attached successfully");
      this._isMediaAttached = true;
      this.checkReady("MEDIA_ATTACHED");
    });

    this._hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        console.error(`[HLS] Fatal Error: ${data.type}`, data);
        const error = new Error(`HLS Error: ${data.type} - ${data.details}`);
        this._rejectLoad?.(error);
      } else {
        console.warn(`[HLS] Non-fatal error: ${data.type}`, data);
      }
    });
  }

  attachMedia(element: HTMLAudioElement): void {
    console.log("[HLS] attachMedia called");
    this.initHls();

    if (!this._hls) throw new Error("HLS failed to initialize");

    this._attachedElement = element;
    this._hls.attachMedia(element);

    // Мы не ставим _isMediaAttached = true здесь вручную,
    // мы ждем события MEDIA_ATTACHED от hls.js для надежности.
  }

  private checkReady(source: string) {
    // Для успешного старта нам нужно:
    // 1. Манифест загружен
    // 2. Медиа элемент присоединен
    // 3. У нас есть промис, который нужно зарезолвить (load был вызван)

    console.log(
      `[HLS] CheckReady from ${source}. Parsed: ${
        this._isManifestParsed
      }, Attached: ${this._isMediaAttached}, HasResolve: ${!!this._resolveLoad}`
    );

    if (
      this._isManifestParsed &&
      this._isMediaAttached &&
      this._resolveLoad &&
      this._attachedElement
    ) {
      console.log("[HLS] Ready! Resolving load promise.");

      this._resolveLoad({
        sourceUrl: this._attachedElement.src, // Это будет blob-url от hls.js
        duration: this._attachedElement.duration || Infinity,
      });

      this._resolveLoad = undefined;
      this._rejectLoad = undefined;
    }
  }

  detachMedia(): void {
    console.log("[HLS] detachMedia");
    this._hls?.detachMedia();
    this._attachedElement = null;
    this._isMediaAttached = false;
  }
  getQualityLevels(): QualityLevel[] {
    return this._qualityLevels;
  }

  setQuality(level: number): void {
    if (this._hls) {
      this._hls.currentLevel = level;
    }
  }
  getCurrentQuality(): number {
    return this._hls?.currentLevel ?? -1;
  }
  private cleanup(): void {
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    this._attachedElement = null;
    this._qualityLevels = [];
    this._isManifestParsed = false;
    this._isMediaAttached = false;
    this._resolveLoad = undefined;
    this._rejectLoad = undefined;
  }
  private formatBitrate(bitrate: number): string {
    if (bitrate >= 1_000_000) {
      return `${(bitrate / 1_000_000).toFixed(1)} Mbps`;
    }
    return `${Math.round(bitrate / 1000)} kbps`;
  }

  dispose(): void {
    this.cleanup();
  }
}
