import { IPlaybackStrategy } from "../strategy/IPlaybackStrategy";
import { QualityLevel, AudioSource } from "../types/index";
import { PlayerError } from "../types/events";

export interface PreparedSource {
  sourceUrl?: string;

  audioBuffer?: AudioBuffer;

  duration: number;

  objectUrlToRevoke?: string;

  metadata?: Record<string, unknown>;
}

export interface SourceCapabilities {
  qualityLevels?: QualityLevel[];
  setQuality?: (level: number) => void;
  getCurrentQuality?: () => number;
  supportsSeek?: boolean;
  isLive?: boolean;
  /**
   * Runtime (post-load) error channel. A handler that surfaces its own runtime
   * errors (e.g. HLS fatal errors after recovery is exhausted) registers the
   * player callback here. Presence of this also signals the player to let the
   * handler own error surfacing (it skips the element error handler to avoid
   * double emission).
   */
  onRuntimeError?: (callback: (error: PlayerError) => void) => void;
}

export interface ISourceHandler {
  readonly id: string;

  canHandle(source: AudioSource): boolean;
  /**
   * Soft hint used only in `mode: 'auto'` to bias strategy selection
   * (`SourceManager.recommendStrategy`). Return `'any'` to express no
   * preference. Never overrides an explicit `mode` — use {@link requiredStrategy}
   * for a hard requirement.
   */
  preferredStrategy(): "html5" | "webaudio" | "any";
  /**
   * Hard strategy requirement. When defined and non-`undefined`, it overrides
   * even an explicit `PlayerOptions.mode` (the player warns when it does).
   * Optional: handlers without a real constraint omit it (falls back to
   * `preferredStrategy` as an auto hint). HLS handlers return `'html5'`.
   */
  requiredStrategy?(): "html5" | "webaudio" | undefined;

  prepare(
    source: AudioSource,
    strategy: IPlaybackStrategy,
    ctx: AudioContext | null,
    signal: AbortSignal
  ): Promise<PreparedSource>;

  getCapabilities(): SourceCapabilities | null;
  dispose(): void;
}
