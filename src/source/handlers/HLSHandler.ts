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
import { isHlsSource } from "./hls-source";
import { playerLogger } from "../../utils/Logger";

interface HlsLevel {
  bitrate: number;
  audioCodec?: string;
}

interface HlsManifestParsedData {
  levels: HlsLevel[];
}

interface HlsErrorData {
  fatal?: boolean;
  type?: string;
  details?: string;
}

interface HlsLevelLoadedData {
  details?: { live?: boolean };
}

export class HLSHandler implements ISourceHandler {
  readonly id = "hls";
  private _hls: HlsInstance | null = null;
  private _Hls: HlsConstructor | null;
  private _config: Partial<HLSConfig>;
  private _qualityLevels: QualityLevel[] = [];
  /** Live flag derived from LEVEL_LOADED manifest details (F-08). */
  private _isLive = false;
  /** Media element of the active load — source of the seekable range. */
  private _mediaElement: HTMLMediaElement | null = null;

  // --- runtime recovery session state (F-07) ---
  /** Retained load signal so backoff retries abort with the load. */
  private _signal: AbortSignal | null = null;
  /** Player callback for unrecoverable runtime errors. */
  private _onRuntimeError: ((error: PlayerError) => void) | null = null;
  private _backoffTimer: number | null = null;
  private _networkRetries = 0;
  /** 0 = none, 1 = did recoverMediaError, 2 = did swapAudioCodec+recover. */
  private _mediaRecoveryStage = 0;

  /** Fatal network errors: up to 3 startLoad() retries with 1s/2s/4s backoff. */
  private static readonly MAX_NETWORK_RETRIES = 3;

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

    return isHlsSource(source);
  }

  preferredStrategy(): "html5" | "webaudio" | "any" {
    return "html5";
  }

  requiredStrategy(): "html5" | "webaudio" | undefined {
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

    this.reset();

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
    this._mediaElement = audioElement;
    const Hls = this._Hls;
    const hls = this._hls;

    this._signal = signal;

    return new Promise<PreparedSource>((resolve, reject) => {
      let resolved = false;

      const onAbort = () => {
        reject(new DOMException("Aborted", "AbortError"));
        this.reset();
      };
      signal.addEventListener("abort", onAbort);

      let manifestParsed = false;
      let mediaAttached = false;
      let firstFragBuffered = false;

      const checkReady = () => {
        if (manifestParsed && mediaAttached && firstFragBuffered) {
          resolved = true;
          signal.removeEventListener("abort", onAbort);
          resolve({
            duration: audioElement.duration || 0,
            metadata: {
              preAttachedMedia: true,
            },
          });
        }
      };

      hls.on(Hls.Events.MANIFEST_PARSED, (_event: unknown, data: unknown) => {
        manifestParsed = true;
        const parsed = data as HlsManifestParsedData;
        this._qualityLevels = parsed.levels.map((lvl, index) => ({
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
        } else {
          // Playback progressing again → a prior recovery succeeded; reset.
          this._networkRetries = 0;
          this._mediaRecoveryStage = 0;
        }
      });

      hls.on(Hls.Events.LEVEL_LOADED, (_event: unknown, data: unknown) => {
        const levelData = data as HlsLevelLoadedData;
        this._isLive = levelData.details?.live ?? false;
      });

      // Persistent error listener — survives resolution. Pre-ready fatals fail
      // the load (as before); post-ready fatals go through recovery (F-07).
      hls.on(Hls.Events.ERROR, (_event: unknown, data: unknown) => {
        const err = data as HlsErrorData;

        if (!err.fatal) {
          playerLogger.debug("HLS non-fatal error", err.type, err.details);
          return;
        }

        if (!resolved) {
          signal.removeEventListener("abort", onAbort);
          this.reset();
          reject(this.toPlayerError(err));
          return;
        }

        this.handleFatalRuntimeError(err);
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
      isLive: this._isLive,
      getSeekableRange: () => this.readSeekableRange(),
      onRuntimeError: (callback: (error: PlayerError) => void) => {
        this._onRuntimeError = callback;
      },
    };
  }

  private readSeekableRange(): { start: number; end: number } | null {
    const ranges = this._mediaElement?.seekable;
    if (!ranges || ranges.length === 0) {
      return null;
    }
    return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
  }

  private formatBitrate(bps: number): string {
    return bps >= 1_000_000
      ? `${(bps / 1_000_000).toFixed(1)} Mbps`
      : `${Math.round(bps / 1000)} kbps`;
  }

  private toPlayerError(data: HlsErrorData): PlayerError {
    const Hls = this._Hls;
    let code = PlayerErrorCode.HLS_FATAL;
    if (Hls && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      code = PlayerErrorCode.HLS_NETWORK;
    } else if (Hls && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      code = PlayerErrorCode.HLS_MEDIA;
    }
    return new PlayerError(
      `HLS Error: ${data.type} - ${data.details}`,
      code,
      data,
    );
  }

  /**
   * Post-load fatal error recovery (F-07):
   * - fatal NETWORK_ERROR → up to 3 startLoad() retries with 1s/2s/4s backoff,
   * - fatal MEDIA_ERROR → recoverMediaError(), then swapAudioCodec()+recover,
   * - otherwise (or exhausted) → destroy + surface via onRuntimeError.
   */
  private handleFatalRuntimeError(data: HlsErrorData): void {
    const Hls = this._Hls;
    const hls = this._hls;
    if (!Hls || !hls) return;

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (this._networkRetries < HLSHandler.MAX_NETWORK_RETRIES) {
        const attempt = this._networkRetries;
        this._networkRetries += 1;
        const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
        playerLogger.debug(
          `HLS fatal network error — retry ${attempt + 1}/${HLSHandler.MAX_NETWORK_RETRIES} in ${delayMs}ms`,
        );
        this._backoffTimer = setTimeout(() => {
          this._backoffTimer = null;
          if (this._signal?.aborted) return;
          this._hls?.startLoad();
        }, delayMs) as unknown as number;
        return;
      }
      this.surfaceFatal(PlayerErrorCode.HLS_NETWORK, data);
      return;
    }

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (this._mediaRecoveryStage === 0) {
        this._mediaRecoveryStage = 1;
        playerLogger.debug("HLS fatal media error — recoverMediaError()");
        hls.recoverMediaError();
        return;
      }
      if (this._mediaRecoveryStage === 1) {
        this._mediaRecoveryStage = 2;
        playerLogger.debug(
          "HLS fatal media error — swapAudioCodec() + recoverMediaError()",
        );
        hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      }
      this.surfaceFatal(PlayerErrorCode.HLS_MEDIA, data);
      return;
    }

    this.surfaceFatal(PlayerErrorCode.HLS_FATAL, data);
  }

  private surfaceFatal(code: PlayerErrorCode, data: HlsErrorData): void {
    const error = new PlayerError(
      `HLS Error: ${data.type} - ${data.details}`,
      code,
      data,
    );
    const notify = this._onRuntimeError;
    this.reset();
    notify?.(error);
  }

  /**
   * Per-load teardown (F-14): destroy the current hls.js session + timers so
   * the singleton handler can be reused for the next load. Keeps `_Hls`.
   */
  reset(): void {
    if (this._backoffTimer !== null) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
    if (this._hls) {
      try {
        this._hls.detachMedia();
      } catch {
        // ignore detach failures during teardown
      }
      this._hls.destroy();
      this._hls = null;
    }
    this._qualityLevels = [];
    this._isLive = false;
    this._mediaElement = null;
    this._networkRetries = 0;
    this._mediaRecoveryStage = 0;
    this._signal = null;
    this._onRuntimeError = null;
  }

  dispose(): void {
    this.reset();
    this._Hls = null;
  }
}
