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
});
