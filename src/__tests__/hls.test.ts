/**
 * Mocking strategy:
 * - HLS behavior is exercised through `Player.load()` with a lightweight in-test
 *   `Hls` constructor mock that emits the exact lifecycle events `HLSHandler`
 *   waits for.
 * - Media readiness is still provided by the shared mocked `Audio` element, so
 *   no real streaming or playlist assets are needed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Player } from "../index";
import type { HlsConstructor } from "../types";
import { PlayerErrorCode } from "../types/events";

class MockHls {
  public static readonly Events = {
    MANIFEST_PARSED: "manifestParsed",
    MEDIA_ATTACHED: "mediaAttached",
    FRAG_BUFFERED: "fragBuffered",
    ERROR: "error",
  };

  public static readonly ErrorTypes = {
    NETWORK_ERROR: "networkError",
    MEDIA_ERROR: "mediaError",
  };

  public static instances: MockHls[] = [];

  public static isSupported(): boolean {
    return true;
  }

  public currentLevel = -1;
  public levels = [
    { bitrate: 256_000, audioCodec: "aac" },
    { bitrate: 1_250_000, audioCodec: "aac" },
  ];

  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(_config?: Record<string, unknown>) {
    MockHls.instances.push(this);
  }

  public loadSource(_url: string): void {
    queueMicrotask(() => {
      this.emit(MockHls.Events.MANIFEST_PARSED, undefined, {
        levels: this.levels,
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
      audio.duration = 180;
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

    player.setQuality(1);
    expect(player.getCurrentQuality()).toBe(1);
    expect(qualityChange).toHaveBeenCalledWith({
      index: 1,
      bitrate: 1250000,
      label: "1.3 Mbps",
      codec: "aac",
    });

    player.setQuality(-1);
    expect(player.getCurrentQuality()).toBe(-1);
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

      // Retry 1 (1s), 2 (2s), 3 (4s): startLoad with exponential backoff.
      hls.emitError("networkError");
      expect(hls.startLoad).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(hls.startLoad).toHaveBeenCalledTimes(1);

      hls.emitError("networkError");
      await vi.advanceTimersByTimeAsync(2000);
      expect(hls.startLoad).toHaveBeenCalledTimes(2);

      hls.emitError("networkError");
      await vi.advanceTimersByTimeAsync(4000);
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
});
