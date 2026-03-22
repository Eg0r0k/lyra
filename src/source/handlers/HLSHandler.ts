import {
  AudioSource,
  HLSConfig,
  QualityLevel,
  DEFAULT_OPTIONS,
  HlsInstance,
  HlsConstructor,
} from "../../types";
import {
  ISourceHandler,
  PreparedSource,
  SourceCapabilities,
} from "../ISourceHandler";
import { PlayerError, PlayerErrorCode } from "../../types/events";
import { IPlaybackStrategy } from "../../strategy/IPlaybackStrategy";
import { HTML5Strategy } from "../../strategy/Html5AudioStrategy";

export class HLSHandler implements ISourceHandler {
  readonly id = "hls";

  private _hls: HlsInstance | null = null;
  private _Hls: HlsConstructor | null;
  private _config: Partial<HLSConfig>;
  private _qualityLevels: QualityLevel[] = [];

  constructor(config?: Partial<HLSConfig>, HlsClass?: HlsConstructor) {
    this._config = config ?? DEFAULT_OPTIONS.hlsConfig;
    this._Hls = HlsClass ?? null;

    if (this._Hls) {
      // noop
    } else {
      console.debug("[HLSHandler] No Hls class provided");
    }
  }

  static isSupported(HlsClass?: HlsConstructor): boolean {
    if (!HlsClass) return false;
    try {
      return HlsClass.isSupported();
    } catch {
      return false;
    }
  }

  canHandle(source: AudioSource): boolean {
    if (!this._Hls) {
      return false;
    }

    if (!this._Hls.isSupported()) {
      return false;
    }

    const url = source.url?.toLowerCase() ?? "";
    return (
      url.includes(".m3u8") || source.format === "m3u8" || source.type === "hls"
    );
  }

  preferredStrategy(): "html5" | "webaudio" | "any" {
    return "html5";
  }

  async prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    _ctx: AudioContext | null,
    signal: AbortSignal,
  ): Promise<PreparedSource> {
    if (!this._Hls) {
      throw new PlayerError(
        "HLS class not provided. Pass Hls class to Player options.",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    }

    if (!(strategy instanceof HTML5Strategy)) {
      throw new PlayerError(
        "HLS requires HTML5Strategy",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    }

    const url = source.url;
    if (!url) {
      throw new PlayerError(
        "HLSHandler requires a URL",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
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

    const audioElement = strategy.getMediaElement?.();
    if (!audioElement) {
      throw new PlayerError(
        "HLS requires an HTML media element",
        PlayerErrorCode.LOAD_NOT_SUPPORTED,
      );
    }
    const Hls = this._Hls;
    const hls = this._hls;

    return new Promise<PreparedSource>((resolve, reject) => {
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

      hls.on(Hls.Events.MANIFEST_PARSED, (_event: unknown, data: any) => {
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

      hls.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
        if (data.fatal) {
          signal.removeEventListener("abort", onAbort);
          this.cleanup();
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
              data,
            ),
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
    this._qualityLevels = [];
  }

  dispose(): void {
    this.cleanup();
  }
}
