import {
  AudioSource,
  HLSConfig,
  QualityLevel,
  DEFAULT_OPTIONS,
} from "../../types";
import {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "../ISourceHandler";
import { PlayerError, PlayerErrorCode } from "../../types/events";
import { IPlaybackStrategy } from "../../strategy/IPlaybackStrategy";
import { HTML5Strategy } from "../../strategy/Html5AudioStrategy";

// Типы для hls.js (чтобы не тянуть зависимость напрямую)
interface HlsInterface {
  loadSource(url: string): void;
  attachMedia(element: HTMLMediaElement): void;
  destroy(): void;
  currentLevel: number;
  levels: Array<{ bitrate: number; audioCodec?: string }>;
  on(event: string, callback: (...args: any[]) => void): void;
}

interface HlsStatic {
  new (config?: Record<string, unknown>): HlsInterface;
  isSupported(): boolean;
  Events: Record<string, string>;
  ErrorTypes: Record<string, string>;
}

/**
 * Обработчик для HLS потоков.
 * Требует hls.js как peer dependency.
 */
export class HLSHandler implements ISourceHandler {
  readonly id = "hls";

  private _hls: HlsInterface | null = null;
  private _Hls: HlsStatic | null = null;
  private _config: Partial<HLSConfig>;
  private _qualityLevels: QualityLevel[] = [];
  private _attachedElement: HTMLAudioElement | null = null;

  constructor(config?: Partial<HLSConfig>) {
    this._config = config ?? DEFAULT_OPTIONS.hlsConfig;
    this.loadHlsLibrary();
  }

  private loadHlsLibrary(): void {
    try {
      // Динамический импорт для опциональной зависимости
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this._Hls = require("hls.js") as HlsStatic;
    } catch {
      this._Hls = null;
    }
  }

  static isSupported(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Hls = require("hls.js") as HlsStatic;
      return Hls.isSupported();
    } catch {
      return false;
    }
  }

  canHandle(source: AudioSource): boolean {
    if (!this._Hls || !this._Hls.isSupported()) {
      return false;
    }

    const url = source.url?.toLowerCase() ?? "";
    return (
      url.includes(".m3u8") || source.format === "m3u8" || source.type === "hls"
    );
  }

  preferredStrategy(): "html5" | "webaudio" | "any" {
    return "html5"; // HLS работает ТОЛЬКО с HTMLAudioElement
  }

  async prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    _ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<PreparedSource> {
    if (!this._Hls) {
      throw new PlayerError(
        "hls.js is not installed. Install it with: npm install hls.js",
        PlayerErrorCode.LOAD_NOT_SUPPORTED
      );
    }

    if (!(strategy instanceof HTML5Strategy)) {
      throw new PlayerError(
        "HLS requires HTML5Strategy",
        PlayerErrorCode.LOAD_NOT_SUPPORTED
      );
    }

    const url = source.url;
    if (!url) {
      throw new PlayerError(
        "HLSHandler requires a URL",
        PlayerErrorCode.LOAD_NOT_SUPPORTED
      );
    }

    this.cleanup();

    this._hls = new this._Hls({
      maxBufferLength: this._config.maxBufferLength,
      maxMaxBufferLength: this._config.maxMaxBufferLength,
      startLevel: this._config.startLevel ?? -1,
      autoStartLoad: this._config.autoStartLoad ?? true,
      enableWorker: this._config.enableWorker ?? true,
    });

    const audioElement = strategy.getAudioElement();
    this._attachedElement = audioElement;

    return new Promise<PreparedSource>((resolve, reject) => {
      if (!this._hls || !this._Hls) {
        return reject(new Error("HLS not initialized"));
      }

      const Hls = this._Hls;
      const hls = this._hls;

      const onAbort = () => {
        reject(new DOMException("Aborted", "AbortError"));
        this.cleanup();
      };
      signal.addEventListener("abort", onAbort);

      let manifestParsed = false;
      let mediaAttached = false;
      let firstFragBuffered = false;

      const checkReady = () => {
        if (manifestParsed && mediaAttached && firstFragBuffered) {
          signal.removeEventListener("abort", onAbort);
          resolve({
            sourceUrl: audioElement.src,
            duration: audioElement.duration || 0,
          });
        }
      };

      hls.on(Hls.Events.MANIFEST_PARSED, (_event: string, data: any) => {
        manifestParsed = true;
        this._qualityLevels = data.levels.map((lvl: any, index: number) => ({
          index,
          bitrate: lvl.bitrate,
          label: this.formatBitrate(lvl.bitrate),
          codec: lvl.audioCodec,
        }));
        checkReady();
      });

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        mediaAttached = true;
        checkReady();
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!firstFragBuffered) {
          firstFragBuffered = true;
          checkReady();
        }
      });

      hls.on(Hls.Events.ERROR, (_event: string, data: any) => {
        if (data.fatal) {
          signal.removeEventListener("abort", onAbort);

          let code = PlayerErrorCode.HLS_FATAL;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            code = PlayerErrorCode.HLS_NETWORK;
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            code = PlayerErrorCode.HLS_MEDIA;
          }

          reject(
            new PlayerError(
              `HLS Error: ${data.type} - ${data.details}`,
              code,
              data
            )
          );
        }
      });

      hls.attachMedia(audioElement);
      hls.loadSource(url);
    });
  }

  getCapabilities(): SourceCapabilities | null {
    if (!this._hls) return null;

    return {
      qualityLevels: this._qualityLevels,
      setQuality: (level: number) => {
        if (this._hls) {
          this._hls.currentLevel = level;
        }
      },
      getCurrentQuality: () => this._hls?.currentLevel ?? -1,
      isLive: false,
    };
  }

  private formatBitrate(bps: number): string {
    return bps >= 1_000_000
      ? `${(bps / 1_000_000).toFixed(1)} Mbps`
      : `${Math.round(bps / 1000)} kbps`;
  }

  private cleanup(): void {
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    this._attachedElement = null;
    this._qualityLevels = [];
  }

  dispose(): void {
    this.cleanup();
  }
}
