/**
 * Mocking strategy:
 * - Tests use the real `Player` event wiring, but all media behavior is driven by
 *   the mocked `Audio` element and mocked `AudioContext` from the shared setup.
 * - `waitFor()` is tested through `Player` because it inherits `EventEmitter`.
 * - Error paths are triggered through mocked fetch/decode failures and mocked
 *   media-element events instead of real network/audio resources.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Player } from "../index";
import {
  MockAudioContext,
  MockMediaError,
  getLatestAudioElement,
  mockFetchSuccess,
  setNextAudioLoadError,
} from "./test-utils";

describe("Player events", () => {
  let player: Player | null = null;

  afterEach(async () => {
    if (player) {
      await player.dispose();
      player = null;
    }
  });

  it("emits statechange on each transition", async () => {
    player = Player.auto();
    const callback = vi.fn();

    player.on("statechange", callback);

    await player.load("https://cdn.example.com/song.mp3");
    await player.play();
    player.pause();
    player.stop();

    expect(callback).toHaveBeenCalledTimes(5);
    expect(callback).toHaveBeenNthCalledWith(1, { from: "idle", to: "loading" });
    expect(callback).toHaveBeenNthCalledWith(2, { from: "loading", to: "ready" });
  });

  it("emits timeupdate payload with currentTime, duration, and progress", async () => {
    player = Player.auto();
    const callback = vi.fn();

    player.on("timeupdate", callback);

    await player.load("https://cdn.example.com/song.mp3");
    getLatestAudioElement().emitTimeUpdate(45);

    expect(callback).toHaveBeenCalledWith({
      currentTime: 45,
      duration: 180,
      progress: 0.25,
    });
  });

  it("emits volumechange on setVolume and toggleMute", async () => {
    player = Player.auto();
    const callback = vi.fn();

    player.on("volumechange", callback);

    await player.load("https://cdn.example.com/song.mp3");
    player.setVolume(0.8);
    player.toggleMute();

    expect(callback).toHaveBeenNthCalledWith(1, { volume: 0.8, muted: false });
    expect(callback).toHaveBeenNthCalledWith(2, { volume: 0.8, muted: true });
  });

  it("emits error when loading fails", async () => {
    player = new Player({ mode: "webaudio" });
    const callback = vi.fn();

    player.on("error", callback);
    mockFetchSuccess();
    MockAudioContext.decodeError = new Error("decode failed");

    await expect(
      player.load({ url: "https://cdn.example.com/fail.mp3" }),
    ).rejects.toThrow();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "LOAD_DECODE",
        message: "Failed to decode audio data",
      }),
    );
  });

  it("emits network load errors with the correct code for HTML5 media failures", async () => {
    player = Player.auto();
    const callback = vi.fn();

    player.on("error", callback);
    setNextAudioLoadError(
      new MockMediaError(MockMediaError.MEDIA_ERR_NETWORK, "network failed"),
    );

    await expect(player.load("https://cdn.example.com/offline.mp3")).rejects.toThrow();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "LOAD_NETWORK",
        message: "Network error while loading media",
      }),
    );
  });

  it("emits ended when the track finishes", async () => {
    player = Player.auto();
    const callback = vi.fn();

    player.on("ended", callback);

    await player.load("https://cdn.example.com/song.mp3");
    await player.play();
    getLatestAudioElement().finish();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(player.state).toBe("ready");
  });

  it("unsubscribe stops further callback invocations", async () => {
    player = Player.auto();
    const callback = vi.fn();

    const unsubscribe = player.on("volumechange", callback);

    await player.load("https://cdn.example.com/song.mp3");
    player.setVolume(0.5);
    unsubscribe();
    player.setVolume(0.7);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ volume: 0.5, muted: false });
  });

  it("waitFor resolves with loadedmetadata payload", async () => {
    player = Player.auto();

    const waitPromise = player.waitFor("loadedmetadata", { timeout: 5000 });
    await player.load("https://cdn.example.com/song.mp3");

    await expect(waitPromise).resolves.toEqual({ duration: 180 });
  });

  it("waitFor rejects on timeout", async () => {
    player = Player.auto();

    await expect(player.waitFor("loadedmetadata", { timeout: 10 })).rejects.toThrow(
      'Timeout waiting for event "loadedmetadata"',
    );
  });
});
