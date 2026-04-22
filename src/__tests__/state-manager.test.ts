/**
 * Mocking strategy:
 * - Unit tests hit `StateManager` directly to verify allowed and invalid
 *   transitions without any media dependencies.
 * - Integration tests use the same mocked `Audio`, `AudioContext`, and `fetch`
 *   environment as `player.test.ts` so state changes reflect the real Player
 *   orchestration code instead of a hand-written stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Player } from "../index";
import { StateManager } from "../core/StateManager";
import { PlayerErrorCode } from "../types/events";
import {
  MockAudioContext,
  createArrayBuffer,
  getLatestAudioElement,
} from "./test-utils";

describe("StateManager", () => {
  it("starts in the idle state", () => {
    const manager = new StateManager();

    expect(manager.state).toBe("idle");
    expect(manager.isIdle).toBe(true);
    expect(manager.isPlayable).toBe(false);
  });

  it("supports the expected transition flow", () => {
    const manager = new StateManager();
    const transitions: Array<{ from: string; to: string }> = [];

    manager.onChange(({ from, to }) => {
      transitions.push({ from, to });
    });

    expect(manager.transition("loading")).toBe(true);
    expect(manager.transition("ready")).toBe(true);
    expect(manager.transition("playing")).toBe(true);
    expect(manager.transition("paused")).toBe(true);
    expect(manager.transition("ready")).toBe(true);

    expect(manager.state).toBe("ready");
    expect(transitions).toEqual([
      { from: "idle", to: "loading" },
      { from: "loading", to: "ready" },
      { from: "ready", to: "playing" },
      { from: "playing", to: "paused" },
      { from: "paused", to: "ready" },
    ]);
  });

  it("allows buffering to transition back to ready", () => {
    const manager = new StateManager();

    expect(manager.transition("loading")).toBe(true);
    expect(manager.transition("ready")).toBe(true);
    expect(manager.transition("playing")).toBe(true);
    expect(manager.transition("buffering")).toBe(true);
    expect(manager.transition("ready")).toBe(true);

    expect(manager.state).toBe("ready");
  });

  it("ignores invalid transitions and warns", () => {
    const manager = new StateManager();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(manager.transition("playing")).toBe(false);
    expect(manager.state).toBe("idle");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("treats disposed as a terminal state", () => {
    const manager = new StateManager();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    manager.dispose();

    expect(manager.state).toBe("disposed");
    expect(manager.isDisposed).toBe(true);
    expect(manager.transition("idle")).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe("Player state integration", () => {
  let player: Player | null = null;

  afterEach(async () => {
    if (player) {
      await player.dispose();
      player = null;
    }
  });

  it("emits the idle -> loading -> ready -> playing -> paused -> ready flow", async () => {
    player = Player.auto();
    const transitions: Array<{ from: string; to: string }> = [];

    player.on("statechange", ({ from, to }) => {
      transitions.push({ from, to });
    });

    await player.load("https://cdn.example.com/song.mp3");
    await player.play();
    player.pause();
    player.stop();

    expect(transitions).toEqual([
      { from: "idle", to: "loading" },
      { from: "loading", to: "ready" },
      { from: "ready", to: "playing" },
      { from: "playing", to: "paused" },
      { from: "paused", to: "ready" },
    ]);
  });

  it("stop moves the player back to ready and resets currentTime", async () => {
    player = Player.auto();

    await player.load("https://cdn.example.com/song.mp3");
    await player.play();

    getLatestAudioElement().emitTimeUpdate(42);
    expect(player.currentTime).toBe(42);

    player.stop();

    expect(player.state).toBe("ready");
    expect(player.currentTime).toBe(0);
  });

  it("stop from buffering returns to ready without warnings", async () => {
    player = Player.auto();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await player.load("https://cdn.example.com/song.mp3");
    await player.play();

    getLatestAudioElement().emitWaiting();
    expect(player.state).toBe("buffering");

    player.stop();

    expect(player.state).toBe("ready");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("moves back to ready when playback ends", async () => {
    player = Player.auto();

    await player.load("https://cdn.example.com/song.mp3");
    await player.play();

    getLatestAudioElement().finish();

    expect(player.state).toBe("ready");
  });

  it("recovers from the error state on a subsequent successful load", async () => {
    player = new Player({ mode: "webaudio" });
    MockAudioContext.decodeError = new Error("decode failed");

    await expect(player.load({ data: createArrayBuffer() })).rejects.toMatchObject({
      code: PlayerErrorCode.LOAD_DECODE,
    });
    expect(player.state).toBe("error");

    MockAudioContext.decodeError = null;

    await expect(player.load({ data: createArrayBuffer() })).resolves.toBeUndefined();
    expect(player.state).toBe("ready");
  });

  it("moves to disposed and stays terminal after dispose", async () => {
    player = Player.auto();

    await player.load("https://cdn.example.com/song.mp3");
    await player.dispose();

    expect(player.state).toBe("disposed");

    await expect(player.load("https://cdn.example.com/again.mp3")).rejects.toMatchObject({
      code: PlayerErrorCode.PLAYBACK_FAILED,
    });

    player = null;
  });
});
