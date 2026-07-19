/**
 * Mocking strategy:
 * - `SourceManager` is tested mostly as a unit with lightweight mock handlers so
 *   selection order, strategy recommendation, active capabilities, and disposal
 *   can be asserted directly.
 * - Real built-in handlers are exercised only where their routing behavior is the
 *   contract under test (URL, Blob, ArrayBuffer, and HLS registration).
 */
import { describe, expect, it, vi } from "vitest";

import { SourceManager } from "../source/SourceManager";
import { UrlHandler } from "../source/handlers/UrlHandler";
import type { ISourceHandler, SourceCapabilities } from "../source/ISourceHandler";
import type { AudioSource, HlsConstructor } from "../types";
import { PlayerErrorCode } from "../types/events";
import { setNativeHlsSupport } from "./test-utils";

class MockHls {
  public static isSupported(): boolean {
    return true;
  }

  public static readonly Events: Record<string, string> = {};
  public static readonly ErrorTypes: Record<string, string> = {};

  public currentLevel = -1;
  public levels: Array<{ bitrate: number; audioCodec?: string }> = [];

  public loadSource(_url: string): void {}
  public attachMedia(_element: HTMLMediaElement): void {}
  public detachMedia(): void {}
  public destroy(): void {}
  public on(_event: string, _callback: (...args: unknown[]) => void): void {}
  public off(_event: string, _callback: (...args: unknown[]) => void): void {}
}

function createMockHandler(options: {
  id: string;
  canHandle?: (source: AudioSource) => boolean;
  preferredStrategy?: () => "html5" | "webaudio" | "any";
  capabilities?: SourceCapabilities | null;
}): ISourceHandler {
  return {
    id: options.id,
    canHandle: options.canHandle ?? (() => false),
    preferredStrategy: options.preferredStrategy ?? (() => "any"),
    prepare: vi.fn(async () => ({ duration: 0 })),
    getCapabilities: vi.fn(() => options.capabilities ?? null),
    dispose: vi.fn(),
  };
}

describe("SourceManager", () => {
  it("selects built-in handlers for URL, Blob, and ArrayBuffer sources", () => {
    const manager = new SourceManager();

    expect(manager.getHandler({ url: "https://cdn.example.com/song.mp3" }).id).toBe(
      "url",
    );
    expect(manager.getHandler({ data: new Blob(["x"]) }).id).toBe("blob");
    expect(manager.getHandler({ data: new Uint8Array([1, 2, 3]) }).id).toBe(
      "buffer",
    );
  });

  it("registers the HLS handler when Hls support is provided", () => {
    const manager = new SourceManager({ Hls: MockHls as unknown as HlsConstructor });

    expect(
      manager.getHandler({ url: "https://cdn.example.com/live/playlist.m3u8", type: "hls" })
        .id,
    ).toBe("hls");
  });

  it("selects the native HLS handler when MSE is unavailable but canPlayType is truthy", () => {
    setNativeHlsSupport(true);
    const manager = new SourceManager(); // no Hls injected

    expect(
      manager.getHandler({
        url: "https://cdn.example.com/live/playlist.m3u8",
        type: "hls",
      }).id,
    ).toBe("hls-native");
  });

  it("prefers hls.js over native HLS when both are available", () => {
    setNativeHlsSupport(true);
    const manager = new SourceManager({ Hls: MockHls as unknown as HlsConstructor });

    expect(
      manager.getHandler({
        url: "https://cdn.example.com/live/playlist.m3u8",
        type: "hls",
      }).id,
    ).toBe("hls");
  });

  it("throws an actionable LOAD_NOT_SUPPORTED for HLS with neither hls.js nor native support", () => {
    setNativeHlsSupport(false);
    const manager = new SourceManager();

    try {
      manager.getHandler({
        url: "https://cdn.example.com/live/playlist.m3u8",
        type: "hls",
      });
      throw new Error("expected getHandler to throw");
    } catch (e) {
      expect(e).toMatchObject({ code: PlayerErrorCode.LOAD_NOT_SUPPORTED });
      const message =
        e && typeof e === "object" && "message" in e ? String(e.message) : "";
      expect(message).toMatch(/hls\.js/i);
      expect(message).toMatch(/native/i);
    }
  });

  it("prefers registered custom handlers over defaults", () => {
    const manager = new SourceManager();
    const customHandler = createMockHandler({
      id: "custom",
      canHandle: (source) => source.url === "https://cdn.example.com/song.mp3",
    });

    manager.registerHandler(customHandler);

    expect(manager.getHandler({ url: "https://cdn.example.com/song.mp3" })).toBe(
      customHandler,
    );
  });

  it("throws LOAD_NOT_SUPPORTED when no handler can process the source", () => {
    const manager = new SourceManager();

    expect(() =>
      manager.getHandler({ data: new ReadableStream<Uint8Array>() }),
    ).toThrowError(
      expect.objectContaining({ code: PlayerErrorCode.LOAD_NOT_SUPPORTED }),
    );
  });

  it("recommends a handler preferred strategy when one is declared", () => {
    const manager = new SourceManager();

    expect(manager.recommendStrategy({ data: new Uint8Array([1]) })).toBe("webaudio");
  });

  it("recommends html5 for URL sources and webaudio for binary buffers", () => {
    const manager = new SourceManager();

    expect(manager.recommendStrategy({ url: "https://cdn.example.com/song.mp3" })).toBe(
      "html5",
    );
    expect(manager.recommendStrategy({ data: new ArrayBuffer(8) })).toBe("webaudio");
  });

  it("falls back to html5 when strategy recommendation cannot resolve a handler", () => {
    const manager = new SourceManager();

    expect(manager.recommendStrategy({ data: new ReadableStream<Uint8Array>() })).toBe(
      "html5",
    );
  });

  it("exposes and clears active handler capabilities", () => {
    const capabilities: SourceCapabilities = {
      qualityLevels: [{ index: 0, bitrate: 128000, label: "128 kbps" }],
      getCurrentQuality: () => 0,
      setQuality: vi.fn(),
      isLive: false,
    };
    const handler = createMockHandler({
      id: "capable",
      capabilities,
    });
    const manager = new SourceManager();

    expect(manager.getActiveCapabilities()).toBeNull();

    manager.setActiveHandler(handler);
    expect(manager.getActiveCapabilities()).toEqual(capabilities);

    manager.clearActiveHandler();
    expect(manager.getActiveCapabilities()).toBeNull();
  });

  it("disposes built-in handlers but not externally registered ones, and clears state", () => {
    const disposeSpy = vi.spyOn(UrlHandler.prototype, "dispose");
    try {
      const manager = new SourceManager();
      const first = createMockHandler({ id: "first" });
      const second = createMockHandler({ id: "second" });

      manager.registerHandler(first);
      manager.registerHandler(second);
      manager.setActiveHandler(first);

      manager.dispose();

      // Built-in handlers (manager-owned) are disposed...
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      // ...but externally registered handlers are caller-owned (survive dispose).
      expect(first.dispose).not.toHaveBeenCalled();
      expect(second.dispose).not.toHaveBeenCalled();

      // Manager state is still cleared regardless of ownership.
      expect(manager.getActiveCapabilities()).toBeNull();
      expect(
        manager.recommendStrategy({ url: "https://cdn.example.com/song.mp3" }),
      ).toBe("html5");
    } finally {
      disposeSpy.mockRestore();
    }
  });
});
