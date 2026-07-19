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

export interface SeekableRange {
  start: number;
  end: number;
}

export interface SourceCapabilities {
  qualityLevels?: QualityLevel[];
  setQuality?: (level: number) => void;
  getCurrentQuality?: () => number;
  /**
   * Post-load quality channel. Register a callback; the handler invokes it
   * whenever the engine actually switches level (e.g. hls.js `LEVEL_SWITCHED`),
   * including ABR-driven switches after `setQuality(-1)`. This is why
   * `Player.setQuality` does not emit `qualitychange` synchronously — the real,
   * engine-selected level arrives here asynchronously.
   *
   * Single-slot: registering again REPLACES the previous callback; there is no
   * unsubscribe. The handler drops it on `reset()`. The player is the only
   * intended subscriber.
   */
  onQualityChange?: (callback: (level: QualityLevel) => void) => void;
  supportsSeek?: boolean;
  isLive?: boolean;
  /**
   * Seekable range of the current source (seconds), when the handler can report
   * it — e.g. the media element's `seekable` for HLS. Returns `null` when no
   * range is available (used to clamp live seeks). For a live stream the window
   * grows over time, so the player re-invokes this on each seek rather than
   * caching the result. Optional.
   */
  getSeekableRange?: () => SeekableRange | null;
  /**
   * Runtime (post-load) error channel. A handler that recovers its own runtime
   * errors and surfaces only the unrecoverable ones (e.g. HLS fatal errors after
   * retries are exhausted) registers the player callback here.
   *
   * Single-slot: registering again REPLACES the previous callback; there is no
   * unsubscribe. The handler drops it on `reset()`. To also suppress the HTML5
   * element's own error handler (avoiding double emission), set
   * {@link SourceCapabilities.ownsMediaErrors} — exposing this channel alone no
   * longer implies it.
   */
  onRuntimeError?: (callback: (error: PlayerError) => void) => void;
  /**
   * When `true`, the handler owns surfacing of media errors for the active
   * source, so the player does NOT attach its HTML5 element error handler
   * (which would double-emit). Set by handlers that drive their own element and
   * report failures via {@link SourceCapabilities.onRuntimeError} (e.g. HLS).
   * An EXPLICIT flag: a handler MAY expose `onRuntimeError` without claiming
   * element-error ownership.
   */
  ownsMediaErrors?: boolean;
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

  /**
   * Capabilities of the active source, or `null` before `prepare()` resolves.
   *
   * SHOULD return the SAME object for the lifetime of a prepared session, with
   * time-varying values (`isLive`, `qualityLevels`) exposed as getters, so the
   * player can hold the reference cheaply on its hot path (`isLive` is read from
   * `timeupdate`). A handler MAY instead return a fresh snapshot per call — the
   * player re-fetches for post-load reads (quality, seekable window) — but its
   * `isLive` may then be frozen at the value seen when the player cached the
   * reference at load (benign: live-ness is settled once at manifest parse).
   */
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
