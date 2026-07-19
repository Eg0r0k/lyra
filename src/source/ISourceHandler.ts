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
   * Seekable range of the current source (seconds), when the handler can
   * report it — e.g. the media element's `seekable` for HLS. Returns `null`
   * when no range is available (used to clamp live seeks). Optional.
   */
  getSeekableRange?(): { start: number; end: number } | null;
  /**
   * Runtime (post-load) error channel. A handler that surfaces its own runtime
   * errors (e.g. HLS fatal errors after recovery is exhausted) registers the
   * player callback here. Presence of this also signals the player to let the
   * handler own error surfacing (it skips the element error handler to avoid
   * double emission).
   */
  onRuntimeError?: (callback: (error: PlayerError) => void) => void;
}

/**
 * A source handler is **constructed once**, then: `prepare` runs per load,
 * {@link ISourceHandler.reset} runs between loads to release the per-load
 * session, and {@link ISourceHandler.dispose} runs once at the end (terminal).
 * For built-in handlers the owning `SourceManager` calls `dispose()`; a handler
 * added via `Player.registerHandler` is caller-owned and the caller disposes it.
 */
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
  /**
   * Release the current per-load session (e.g. an hls.js instance, timers)
   * WITHOUT tearing the handler down — it will be reused for the next load.
   * Called by the player after each load. Optional: handlers with no per-load
   * state omit it. Distinct from {@link dispose}, which is terminal.
   */
  reset?(): void;
  /**
   * Terminal teardown, invoked once. For built-in handlers this is called by
   * `SourceManager.dispose()`; for caller-registered handlers the caller
   * invokes it (the player never disposes a registered handler).
   */
  dispose(): void;
}
