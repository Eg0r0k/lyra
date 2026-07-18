/**
 * Mocking strategy:
 * - `Player` is exercised in `webaudio` mode using the shared mocked
 *   `AudioContext`, gain/filter/analyser nodes, and a fake decoded buffer.
 * - `AudioGraph` is also tested directly so EQ and analyser behavior can be
 *   asserted without depending on Player orchestration for every branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AudioGraph } from "../audio/AudioGraph";
import { Player } from "../index";
import {
  MockAudioContext,
  MockAudioElement,
  createArrayBuffer,
  getLatestBufferSourceNode,
  getLatestAudioElement,
  getLatestAudioContext,
  getLatestGainNode,
  getFadeGainNode,
} from "./test-utils";

describe("AudioGraph", () => {
  let player: Player | null = null;

  afterEach(async () => {
    if (player) {
      await player.dispose();
      player = null;
    }
  });

  beforeEach(() => {
    MockAudioContext.decodedDuration = 90;
  });

  it("is null before load and available after a webaudio load", async () => {
    player = new Player({ mode: "webaudio" });

    expect(player.graph).toBeNull();

    await player.load({ data: createArrayBuffer() });

    expect(player.graph).not.toBeNull();
    expect(player.mode).toBe("webaudio");
  });

  it("exposes 10 EQ bands and supports EQ updates/reset", () => {
    const graph = new AudioGraph(new MockAudioContext() as unknown as AudioContext);

    expect(graph.bands).toHaveLength(10);

    graph.setEQBand(0, 3);
    graph.setEQBand(1, -6);
    expect(graph.getEQBand(0)).toBe(3);
    expect(graph.getEQBand(1)).toBe(-6);

    graph.setEQBands([1, 2, 3]);
    expect(graph.getEQBand(0)).toBe(1);
    expect(graph.getEQBand(1)).toBe(2);
    expect(graph.getEQBand(2)).toBe(3);

    graph.resetEQ();
    expect(graph.getEQBand(0)).toBe(0);
    expect(graph.getEQBand(1)).toBe(0);
    expect(graph.getEQBand(2)).toBe(0);
  });

  it("toggles EQ enabled state", () => {
    const graph = new AudioGraph(new MockAudioContext() as unknown as AudioContext);

    expect(graph.eqEnabled).toBe(true);

    graph.setEQEnabled(false);
    expect(graph.eqEnabled).toBe(false);

    graph.setEQEnabled(true);
    expect(graph.eqEnabled).toBe(true);
  });

  it("returns Uint8Array analyser data", () => {
    const graph = new AudioGraph(new MockAudioContext() as unknown as AudioContext);

    const frequencyData = graph.getFrequencyData();
    const timeDomainData = graph.getTimeDomainData();

    expect(frequencyData).toBeInstanceOf(Uint8Array);
    expect(timeDomainData).toBeInstanceOf(Uint8Array);
    expect(frequencyData.length).toBeGreaterThan(0);
    expect(timeDomainData.length).toBeGreaterThan(0);
    expect(frequencyData[0]).toBe(64);
    expect(timeDomainData[0]).toBe(128);
  });

  it("finalizes fade gain so later fades do not start from stale AudioParam value", async () => {
    vi.useFakeTimers();
    const graph = new AudioGraph(new MockAudioContext() as unknown as AudioContext);
    // fadeTo drives the fade gain (second-to-last created), not the volume gain.
    const fadeGain = getFadeGainNode() as unknown as {
      gain: { value: number; setValueAtTime: Mock };
    };

    const fadePromise = graph.fadeTo(0.4, 0.1);

    await vi.advanceTimersByTimeAsync(180);
    await fadePromise;

    // Bug guarded: the completion timer pins the fade gain to its final value so
    // a later fade doesn't start from a stale ramping AudioParam value.
    expect(fadeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.4, 0);
    expect(fadeGain.gain.value).toBe(0.4);

    vi.useRealTimers();
  });

  it("does not make HTML5 playback quieter after repeated fade out and fade in cycles", async () => {
    player = new Player({ mode: "html5", volume: 0.5 });

    await player.load("https://cdn.example.com/song.mp3");

    for (let i = 0; i < 3; i += 1) {
      await player.play();
      await player.fadeOutAndPause(0);
      await player.fadeIn(0);
    }

    const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };
    const fadeGain = getFadeGainNode() as unknown as { gain: { value: number } };

    // T-10 ownership: routed html5 pins the element to unity; user volume lives on
    // the graph volume gain, and the fade multiplier returns to 1 after cycles —
    // no drift (effective 0.5 × 1).
    expect(getLatestAudioElement().volume).toBe(1);
    expect(volumeGain.gain.value).toBe(0.5);
    expect(fadeGain.gain.value).toBe(1);
  });

  it("restores fade gain and keeps volume independent when a fade is cancelled mid-flight", async () => {
    vi.useFakeTimers();
    const graph = new AudioGraph(new MockAudioContext() as unknown as AudioContext);
    const volumeGain = getLatestGainNode() as unknown as {
      gain: { value: number };
    };
    const fadeGain = getFadeGainNode() as unknown as {
      gain: { value: number; setValueAtTime: Mock };
    };

    graph.setVolumeImmediate(0.5);
    expect(volumeGain.gain.value).toBe(0.5);

    graph.fadeTo(0.8, 1);
    await vi.advanceTimersByTimeAsync(300);
    graph.cancelFade();

    // Cancel-restore bug guarded: cancelFade pins the fade gain to its pre-fade
    // value (1) instead of leaving a stale ramp. Volume (0.5) is untouched by the
    // fade/cancel — the F-13 independence fix.
    expect(fadeGain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, expect.any(Number));
    expect(fadeGain.gain.value).toBe(1);
    expect(volumeGain.gain.value).toBe(0.5);

    vi.useRealTimers();
  });

  it("maintains consistent volume across rapid fade cancellations", async () => {
    vi.useFakeTimers();
    player = new Player({ mode: "html5", volume: 0.8 });

    await player.load("https://cdn.example.com/song.mp3");

    await player.play();

    for (let i = 0; i < 5; i++) {
      player.fadeOut(0.5);
      await vi.advanceTimersByTimeAsync(100);
      player.cancelFade();
    }

    const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };
    const fadeGain = getFadeGainNode() as unknown as { gain: { value: number } };

    expect(fadeGain.gain.value).toBe(1);
    expect(volumeGain.gain.value).toBe(0.8);
    expect(getLatestAudioElement().volume).toBe(1);

    vi.useRealTimers();
  });

  it("applies HTML5 volume via the graph (element pinned) before play starts", async () => {
    const playSpy = vi.spyOn(MockAudioElement.prototype, "play");
    player = new Player({ mode: "html5", autoplay: true, volume: 0.2 });

    await player.load("https://cdn.example.com/song.mp3");

    // T-10 (F-11): routed html5 applies user volume to the graph volume gain, not
    // the element (which iOS ignores). The element is pinned to unity.
    const volumeGain = getLatestGainNode() as unknown as {
      gain: { setValueAtTime: Mock; setTargetAtTime: Mock };
    };

    expect(volumeGain.gain.setValueAtTime).toHaveBeenCalledWith(0.2, 0);
    expect(volumeGain.gain.setValueAtTime.mock.invocationCallOrder[0]).toBeLessThan(
      playSpy.mock.invocationCallOrder[0],
    );
    expect(getLatestAudioElement().volume).toBe(1);

    playSpy.mockRestore();
  });

  it("applies initial graph volume immediately for webaudio autoplay before buffer start", async () => {
    player = new Player({ mode: "webaudio", autoplay: true, volume: 0.2 });

    await player.load({ data: createArrayBuffer() });

    const outputGain = getLatestGainNode() as unknown as {
      gain: {
        setValueAtTime: ReturnType<typeof vi.fn>;
        setTargetAtTime: ReturnType<typeof vi.fn>;
      };
    };
    const bufferSource = getLatestBufferSourceNode() as unknown as {
      start: ReturnType<typeof vi.fn>;
    };

    expect(outputGain.gain.setValueAtTime).toHaveBeenCalledWith(0.2, 0);
    expect(outputGain.gain.setValueAtTime.mock.invocationCallOrder[0]).toBeLessThan(
      bufferSource.start.mock.invocationCallOrder[0],
    );
  });

  it("routes the second loaded track's own gain node into the shared graph (regression)", async () => {
    player = new Player({ mode: "webaudio" });

    // Strategy.initialize() creates its own GainNode *before* the shared
    // AudioGraph's nodes are created, so it is always the first gain node
    // created during a given load() call.
    await player.load({ data: createArrayBuffer() });
    const ctx = getLatestAudioContext();
    const firstStrategyGain = ctx.createdGains[0] as unknown as {
      connect: ReturnType<typeof vi.fn>;
    };
    await player.play();

    const graph = player.graph;
    expect(firstStrategyGain.connect).toHaveBeenCalledWith(graph!.input);

    const gainsBeforeSecondLoad = ctx.createdGains.length;

    await player.load({ data: createArrayBuffer() });
    const secondStrategyGain = ctx.createdGains[gainsBeforeSecondLoad] as unknown as {
      connect: ReturnType<typeof vi.fn>;
    };
    await player.play();

    // Regression guard: previously `play()` only rebuilt the graph routing
    // when `this._audioGraph` was null, which is only true once per Player
    // instance. Every subsequent track's strategy output was left
    // unconnected (silent in webaudio mode, bypassing the graph/EQ/fades
    // in html5 mode).
    expect(secondStrategyGain.connect).toHaveBeenCalledWith(graph!.input);
    expect(player.graph).toBe(graph);
  });

  it("player graph uses the shared audio context after load", async () => {
    player = new Player({ mode: "webaudio" });

    await player.load({ data: createArrayBuffer() });

    const graph = player.graph;
    expect(graph).not.toBeNull();
    expect(player.audioContext).toBe(getLatestAudioContext() as unknown as AudioContext);
    expect(graph?.bands).toHaveLength(10);
  });

  it("fade does not corrupt player.volume and volume stays independent of fade (F-13)", async () => {
    player = new Player({ mode: "html5", volume: 0.6 });
    await player.load("https://cdn.example.com/song.mp3");
    await player.play();

    await player.fadeTo(0.3, 0); // instant fade multiplier

    const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };
    const fadeGain = getFadeGainNode() as unknown as { gain: { value: number } };

    expect(player.volume).toBe(0.6); // authoritative user volume unchanged
    expect(volumeGain.gain.value).toBe(0.6);
    expect(fadeGain.gain.value).toBeCloseTo(0.3);

    // setVolume behaves independently of the active fade multiplier.
    player.setVolume(0.4);
    expect(volumeGain.gain.value).toBe(0.4);
    expect(fadeGain.gain.value).toBeCloseTo(0.3);
  });

  it("fadeOutAndPause resets the fade gain to 1 without touching volume", async () => {
    player = new Player({ mode: "html5", volume: 0.7 });
    await player.load("https://cdn.example.com/song.mp3");
    await player.play();

    await player.fadeOutAndPause(0);

    const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };
    const fadeGain = getFadeGainNode() as unknown as { gain: { value: number } };

    expect(player.state).toBe("paused");
    expect(fadeGain.gain.value).toBe(1); // fade multiplier reset (no restore hack)
    expect(volumeGain.gain.value).toBe(0.7); // volume untouched
  });

  it("un-routed html5 (webAudioRouting:'never') applies volume to the element", async () => {
    player = new Player({ mode: "html5", webAudioRouting: "never", volume: 0.5 });
    await player.load("https://cdn.example.com/song.mp3");

    expect(player.graph).toBeNull();
    expect(getLatestAudioElement().volume).toBe(0.5);

    player.setVolume(0.3);
    expect(getLatestAudioElement().volume).toBe(0.3);
  });
});
