/**
 * Mocking strategy:
 * - HLS behavior is exercised through `Player.load()` with a lightweight in-test
 *   `Hls` constructor mock that emits the exact lifecycle events `HLSHandler`
 *   waits for.
 * - Media readiness is still provided by the shared mocked `Audio` element, so
 *   no real streaming or playlist assets are needed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Player, HLSHandler, HTML5Strategy } from "../index";
import type { HlsConstructor } from "../types";
import { PlayerErrorCode } from "../types/events";
import { getLatestAudioElement } from "./test-utils";

class MockHls {
  public static readonly Events = {
    MANIFEST_PARSED: "manifestParsed",
    MEDIA_ATTACHED: "mediaAttached",
    FRAG_BUFFERED: "fragBuffered",
    LEVEL_LOADED: "levelLoaded",
    LEVEL_SWITCHED: "levelSwitched",
    ERROR: "error",
  };

  /** When true, the next load emits a live LEVEL_LOADED + Infinity duration. */
  public static live = false;

  public static readonly ErrorTypes = {
    NETWORK_ERROR: "networkError",
    MEDIA_ERROR: "mediaError",
  };

  public static instances: MockHls[] = [];

  public static isSupported(): boolean {
    return true;
  }

  private _currentLevel = -1;
  public get currentLevel(): number {
    return this._currentLevel;
  }
  // Setting the level triggers a real LEVEL_SWITCHED (auto → ABR picks index 0),
  // mirroring hls.js so the relay → qualitychange path is exercised.
  public set currentLevel(value: number) {
    this._currentLevel = value;
    this.emit(MockHls.Events.LEVEL_SWITCHED, undefined, {
      level: value === -1 ? 0 : value,
    });
  }
  public levels = [
    { bitrate: 256_000, audioCodec: "aac" },
    { bitrate: 1_250_000, audioCodec: "aac" },
  ];

  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  public readonly config: Record<string, unknown>;

  constructor(config?: Record<string, unknown>) {
    this.config = config ?? {};
    MockHls.instances.push(this);
  }

  public loadSource(_url: string): void {
    queueMicrotask(() => {
      this.emit(MockHls.Events.MANIFEST_PARSED, undefined, {
        levels: this.levels,
      });
      this.emit(MockHls.Events.LEVEL_LOADED, undefined, {
        details: { live: MockHls.live },
      });
      this.emit(MockHls.Events.FRAG_BUFFERED);
    });
  }

  public attachMedia(media: HTMLMediaElement): void {
    queueMicrotask(() => {
      const audio = media as HTMLAudioElement & {
        readyState: number;
        duration: number;
      };
      audio.readyState = 4;
      audio.duration = MockHls.live ? Infinity : 180;
      audio.dispatchEvent(new Event("loadedmetadata"));
      audio.dispatchEvent(new Event("canplay"));
      this.emit(MockHls.Events.MEDIA_ATTACHED);
    });
  }

  public detachMedia(): void {
    // noop
  }

  public destroy(): void {
    this.listeners.clear();
  }

  public readonly startLoad = vi.fn(() => undefined);
  public readonly stopLoad = vi.fn(() => undefined);
  public readonly recoverMediaError = vi.fn(() => undefined);
  public readonly swapAudioCodec = vi.fn(() => undefined);

  /** Test helper: emit a fatal HLS error of the given type. */
  public emitError(type: string, details = "fatal"): void {
    this.emit(MockHls.Events.ERROR, undefined, { fatal: true, type, details });
  }

  /** Test helper: emit a fragment-buffered event (simulates recovered playback). */
  public emitFragBuffered(): void {
    this.emit(MockHls.Events.FRAG_BUFFERED);
  }

  public on(event: string, callback: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    set.add(callback);
    this.listeners.set(event, set);
  }

  public off(event: string, callback: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(event) ?? []) {
      callback(...args);
    }
  }
}

describe("HLS", () => {
  let player: Player | null = null;

  afterEach(async () => {
    if (player) {
      await player.dispose();
      player = null;
    }
    MockHls.instances = [];
    MockHls.live = false;
  });

  it("emits qualitiesavailable with QualityLevel payloads", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });
    const callback = vi.fn();

    player.on("qualitiesavailable", callback);

    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      { index: 0, bitrate: 256000, label: "256 kbps", codec: "aac" },
      { index: 1, bitrate: 1250000, label: "1.3 Mbps", codec: "aac" },
    ]);
  });

  it("supports setQuality(index), setQuality(-1), getQualityLevels, and getCurrentQuality", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });
    const qualityChange = vi.fn();

    player.on("qualitychange", qualityChange);

    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });

    expect(player.getQualityLevels()).toEqual([
      { index: 0, bitrate: 256000, label: "256 kbps", codec: "aac" },
      { index: 1, bitrate: 1250000, label: "1.3 Mbps", codec: "aac" },
    ]);
    expect(player.getCurrentQuality()).toBe(-1);

    // Explicit level: returns true; qualitychange arrives via LEVEL_SWITCHED
    // relay with the real level (not a synchronous synthetic emit).
    expect(player.setQuality(1)).toBe(true);
    expect(player.getCurrentQuality()).toBe(1);
    expect(qualityChange).toHaveBeenCalledWith({
      index: 1,
      bitrate: 1250000,
      label: "1.3 Mbps",
      codec: "aac",
    });

    // Auto (-1): returns true; ABR picks a real level → relayed as qualitychange
    // (the F-20 gap — auto used to emit nothing).
    qualityChange.mockClear();
    expect(player.setQuality(-1)).toBe(true);
    expect(player.getCurrentQuality()).toBe(-1);
    expect(qualityChange).toHaveBeenCalledWith({
      index: 0,
      bitrate: 256000,
      label: "256 kbps",
      codec: "aac",
    });

    // Invalid index: no-op, returns false, no further qualitychange.
    qualityChange.mockClear();
    expect(player.setQuality(99)).toBe(false);
    expect(qualityChange).not.toHaveBeenCalled();
    expect(player.getCurrentQuality()).toBe(-1);
  });

  it("passes the full merged hlsConfig through to the Hls constructor (F-19)", async () => {
    player = new Player({
      Hls: MockHls as unknown as HlsConstructor,
      hlsConfig: { maxBufferLength: 10, startFragPrefetch: true, customKey: "x" },
    });
    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });

    const hls = MockHls.instances[MockHls.instances.length - 1];
    expect(hls.config.maxBufferLength).toBe(10); // user override
    expect(hls.config.maxMaxBufferLength).toBe(60); // default preserved
    expect(hls.config.startFragPrefetch).toBe(true); // now forwarded (was dead)
    expect(hls.config.customKey).toBe("x"); // arbitrary key passes through
  });

  const loadAndPlay = async (p: Player): Promise<MockHls> => {
    await p.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });
    await p.play();
    return MockHls.instances[MockHls.instances.length - 1];
  };

  it("fatal network error triggers startLoad retries then HLS_NETWORK", async () => {
    vi.useFakeTimers();
    try {
      player = new Player({ Hls: MockHls as unknown as HlsConstructor });
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      const hls = await loadAndPlay(player);
      expect(player.state).toBe("playing");

      // Retry 1 (1s), 2 (2s), 3 (4s): startLoad with exponential backoff. The
      // boundary is asserted to the millisecond, so a regressed shorter or
      // non-exponential backoff is caught — not merely the retry count.
      hls.emitError("networkError");
      expect(hls.startLoad).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(hls.startLoad).not.toHaveBeenCalled(); // 1s backoff not elapsed
      await vi.advanceTimersByTimeAsync(1);
      expect(hls.startLoad).toHaveBeenCalledTimes(1);

      hls.emitError("networkError");
      await vi.advanceTimersByTimeAsync(1999);
      expect(hls.startLoad).toHaveBeenCalledTimes(1); // 2s backoff not elapsed
      await vi.advanceTimersByTimeAsync(1);
      expect(hls.startLoad).toHaveBeenCalledTimes(2);

      hls.emitError("networkError");
      await vi.advanceTimersByTimeAsync(3999);
      expect(hls.startLoad).toHaveBeenCalledTimes(2); // 4s backoff not elapsed
      await vi.advanceTimersByTimeAsync(1);
      expect(hls.startLoad).toHaveBeenCalledTimes(3);

      // Playback state untouched, no error yet.
      expect(player.state).toBe("playing");
      expect(errorSpy).not.toHaveBeenCalled();

      // Retries exhausted → single HLS_NETWORK error + error state.
      hls.emitError("networkError");
      expect(hls.startLoad).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: PlayerErrorCode.HLS_NETWORK }),
      );
      expect(player.state).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fatal media error recovers via recoverMediaError without player error", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });
    const errorSpy = vi.fn();
    player.on("error", errorSpy);

    const hls = await loadAndPlay(player);

    // Stage 1: recoverMediaError only.
    hls.emitError("mediaError");
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(hls.swapAudioCodec).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(player.state).toBe("playing");

    // Stage 2: swapAudioCodec + recoverMediaError.
    hls.emitError("mediaError");
    expect(hls.swapAudioCodec).toHaveBeenCalledTimes(1);
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();

    // Exhausted: single HLS_MEDIA error + error state.
    hls.emitError("mediaError");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: PlayerErrorCode.HLS_MEDIA }),
    );
    expect(player.state).toBe("error");
  });

  it("resets the network retry budget after playback recovers", async () => {
    vi.useFakeTimers();
    try {
      player = new Player({ Hls: MockHls as unknown as HlsConstructor });
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      const hls = await loadAndPlay(player);

      hls.emitError("networkError");
      await vi.advanceTimersByTimeAsync(1000);
      expect(hls.startLoad).toHaveBeenCalledTimes(1);

      // Playback resumes → retry budget resets.
      hls.emitFragBuffered();

      // A fresh network error starts the budget over (1s backoff again).
      hls.emitError("networkError");
      await vi.advanceTimersByTimeAsync(1000);
      expect(hls.startLoad).toHaveBeenCalledTimes(2);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup during backoff leaves no timers", async () => {
    vi.useFakeTimers();
    try {
      player = new Player({ Hls: MockHls as unknown as HlsConstructor });
      const hls = await loadAndPlay(player);

      hls.emitError("networkError"); // schedules a 1s backoff timer
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await player.dispose();
      player = null;

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(hls.startLoad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlapping fatal network errors leave a single backoff timer (F-40)", async () => {
    vi.useFakeTimers();
    try {
      player = new Player({ Hls: MockHls as unknown as HlsConstructor });
      const hls = await loadAndPlay(player);

      hls.emitError("networkError"); // schedules the first backoff (1s)
      hls.emitError("networkError"); // supersedes it — the first must be cleared

      // Without the clearTimeout guard both timers would be pending here.
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4000);

      // Only the surviving timer fires → one startLoad, not two.
      expect(hls.startLoad).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runtime error while paused transitions to error (F-35)", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });
    const hls = await loadAndPlay(player);

    player.pause();
    expect(player.state).toBe("paused");

    const errorSpy = vi.fn();
    player.on("error", errorSpy);

    // Non-network/non-media fatal → immediate give-up, surfaced while paused.
    hls.emitError("otherError");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: PlayerErrorCode.HLS_FATAL }),
    );
    expect(player.state).toBe("error");
  });

  it("runtime error while ready (after load, before play) transitions to error (F-35)", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });
    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });
    expect(player.state).toBe("ready");

    const hls = MockHls.instances[MockHls.instances.length - 1];
    const errorSpy = vi.fn();
    player.on("error", errorSpy);

    hls.emitError("otherError");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(player.state).toBe("error");
  });

  it("reuses the handler across loads, giving each a fresh hls session (T-14/F-15)", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });

    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });
    expect(MockHls.instances).toHaveLength(1);
    const first = MockHls.instances[0];
    const destroySpy = vi.spyOn(first, "destroy");

    // Second load on the SAME player: the handler is reused (reset, not
    // disposed), so the prior hls session is destroyed and a fresh one created.
    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });

    expect(destroySpy).toHaveBeenCalledTimes(1); // old session torn down on reset
    expect(MockHls.instances).toHaveLength(2); // fresh session for load 2
    expect(player.state).toBe("ready"); // handler still usable (not disposed)
  });

  it("live manifest reports isLive and Infinity duration (T-15/F-08)", async () => {
    MockHls.live = true;
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });

    const timeupdates: number[] = [];
    player.on("timeupdate", ({ progress }) => timeupdates.push(progress));

    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });

    expect(player.isLive).toBe(true);
    expect(player.duration).toBe(Infinity);

    // progress is 0 for live even as time advances.
    const el = getLatestAudioElement();
    el.currentTime = 42;
    el.dispatchEvent(new Event("timeupdate"));
    expect(timeupdates[timeupdates.length - 1]).toBe(0);
  });

  it("clamps live seeks to the seekable range and no-ops when empty (T-15/F-08)", async () => {
    MockHls.live = true;
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });
    await player.load({
      url: "https://cdn.example.com/live/playlist.m3u8",
      type: "hls",
    });

    const el = getLatestAudioElement();
    el.setSeekableRange(30, 120);

    player.seek(500); // beyond the window → clamp to end
    expect(el.currentTime).toBe(120);

    player.seek(5); // before the window → clamp to start
    expect(el.currentTime).toBe(30);

    // Empty seekable window → seek is a no-op (no seeking emitted, no move).
    el.setSeekableRange(0, 0);
    const seeking = vi.fn();
    player.on("seeking", seeking);
    player.seek(60);
    expect(seeking).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(30);
  });

  it("VOD stream keeps finite duration and real progress (T-15 regression)", async () => {
    player = new Player({ Hls: MockHls as unknown as HlsConstructor });

    const progresses: number[] = [];
    player.on("timeupdate", ({ progress }) => progresses.push(progress));

    await player.load({
      url: "https://cdn.example.com/vod/playlist.m3u8",
      type: "hls",
    });

    expect(player.isLive).toBe(false);
    expect(player.duration).toBe(180);

    const el = getLatestAudioElement();
    el.currentTime = 90;
    el.dispatchEvent(new Event("timeupdate"));
    expect(progresses[progresses.length - 1]).toBeCloseTo(0.5);
  });

  it("getCapabilities returns a stable per-session object that owns media errors (T-30)", async () => {
    const handler = new HLSHandler(
      undefined,
      MockHls as unknown as HlsConstructor,
    );
    const strategy = new HTML5Strategy();

    await handler.prepare(
      { url: "https://cdn.example.com/p.m3u8", type: "hls" },
      strategy,
      null,
      new AbortController().signal,
    );

    const caps1 = handler.getCapabilities();
    const caps2 = handler.getCapabilities();

    // Same reference across calls (F-52: the player can cache it cheaply).
    expect(caps1).not.toBeNull();
    expect(caps1).toBe(caps2);
    // Explicit media-error ownership (T-30 dedupe signal).
    expect(caps1?.ownsMediaErrors).toBe(true);

    // reset() drops the session object; with no hls session capabilities are null.
    handler.reset();
    expect(handler.getCapabilities()).toBeNull();

    strategy.dispose();
    handler.dispose();
  });
});
