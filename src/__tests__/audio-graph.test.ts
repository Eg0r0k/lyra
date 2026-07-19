/**
 * Mocking strategy:
 * - `Player` is exercised in `webaudio` mode using the shared mocked
 *   `AudioContext`, gain/filter/analyser nodes, and a fake decoded buffer.
 * - `AudioGraph` is also tested directly so EQ and analyser behavior can be
 *   asserted without depending on Player orchestration for every branch.
 * - Fade/volume value assertions advance the shared audio clock via
 *   `advanceAudioTime` (T-31): AudioParam values are computed from the
 *   automation timeline at `ctx.currentTime`, so the tests read real ramped
 *   values instead of mirroring which mock method was called.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AudioGraph } from "../audio/AudioGraph";
import { Player } from "../index";
import {
  MockAudioContext,
  advanceAudioTime,
  createArrayBuffer,
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

  it("uses a smoothed param ramp for EQ band updates (T-17/F-21)", () => {
    const ctx = new MockAudioContext();
    const graph = new AudioGraph(ctx as unknown as AudioContext);
    const band0 = ctx.createdBiquadFilters[0] as unknown as {
      gain: { setTargetAtTime: Mock; setValueAtTime: Mock };
    };

    graph.setEQBand(0, 6);

    // Smoothed ramp, not a step, to avoid zipper noise on slider drags.
    expect(band0.gain.setTargetAtTime).toHaveBeenCalledWith(
      6,
      expect.any(Number),
      0.015,
    );
    expect(band0.gain.setValueAtTime).not.toHaveBeenCalled();
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

  it("ramps the fade gain over time and finalizes it at the target (T-31 real clock)", async () => {
    vi.useFakeTimers();
    try {
      const graph = new AudioGraph(
        new MockAudioContext() as unknown as AudioContext,
      );
      const fadeGain = getFadeGainNode() as unknown as {
        gain: { value: number };
      };

      const fadePromise = graph.fadeTo(0.4, 0.1);

      // Mid-flight the exponential ramp (1 -> 0.4) is genuinely between the
      // endpoints. The old instant mock jumped to 0.4 on the ramp call, so this
      // strictly-between assertion would have failed then — it is now real.
      await advanceAudioTime(60);
      const mid = fadeGain.gain.value;
      expect(mid).toBeLessThan(1);
      expect(mid).toBeGreaterThan(0.4);

      await advanceAudioTime(200);
      await fadePromise;

      // The completion timer pins the fade gain to its final value so a later
      // fade starts from a settled param, not a stale mid-ramp value. Reverting
      // AudioGraph's finalizing setValueAtTime leaves this at the ramp's SILENCE
      // asymptote / stale value and fails here.
      expect(fadeGain.gain.value).toBeCloseTo(0.4, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ramps a fade to silence through the SILENCE_GAIN floor and lands at 0 (guards the exponential-ramp floor)", async () => {
    vi.useFakeTimers();
    try {
      // If AudioGraph.fadeTo ramped to a raw 0 instead of SILENCE_GAIN, the
      // scheduling mock throws (exponentialRampToValueAtTime target must be > 0)
      // at schedule time, so this call would throw synchronously.
      const graph = new AudioGraph(
        new MockAudioContext() as unknown as AudioContext,
      );
      const fadeGain = getFadeGainNode() as unknown as {
        gain: { value: number };
      };

      const fadePromise = graph.fadeTo(0, 0.1);

      // The exponential ramp never reaches 0 mid-flight (that is the whole point
      // of the SILENCE_GAIN floor) — value stays strictly positive.
      await advanceAudioTime(60);
      const mid = fadeGain.gain.value;
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);

      await advanceAudioTime(200);
      await fadePromise;

      // Completion pins exactly 0.
      expect(fadeGain.gain.value).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
    try {
      const graph = new AudioGraph(
        new MockAudioContext() as unknown as AudioContext,
      );
      const volumeGain = getLatestGainNode() as unknown as {
        gain: { value: number };
      };
      const fadeGain = getFadeGainNode() as unknown as {
        gain: { value: number };
      };

      graph.setVolumeImmediate(0.5);
      expect(volumeGain.gain.value).toBe(0.5);

      void graph.fadeTo(0.8, 1);
      await advanceAudioTime(300);

      // Genuinely mid-ramp (1 -> 0.8): only true with the scheduling mock.
      const mid = fadeGain.gain.value;
      expect(mid).toBeLessThan(1);
      expect(mid).toBeGreaterThan(0.8);

      graph.cancelFade();

      // cancelFade pins the fade gain to its pre-fade value (1); volume (0.5) is
      // untouched by the fade/cancel — the F-13 independence fix.
      expect(fadeGain.gain.value).toBe(1);
      expect(volumeGain.gain.value).toBe(0.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintains consistent volume across rapid fade cancellations", async () => {
    vi.useFakeTimers();
    try {
      player = new Player({ mode: "html5", volume: 0.8 });

      await player.load("https://cdn.example.com/song.mp3");

      await player.play();

      for (let i = 0; i < 5; i++) {
        void player.fadeOut(0.5);
        await advanceAudioTime(100);
        player.cancelFade();
      }

      const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };
      const fadeGain = getFadeGainNode() as unknown as { gain: { value: number } };

      expect(fadeGain.gain.value).toBe(1);
      expect(volumeGain.gain.value).toBe(0.8);
      expect(getLatestAudioElement().volume).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies HTML5 volume via the graph (element pinned)", async () => {
    player = new Player({ mode: "html5", autoplay: true, volume: 0.2 });

    await player.load("https://cdn.example.com/song.mp3");

    // T-10 (F-11): routed html5 applies user volume to the graph volume gain
    // immediately (setValueAtTime, so the value is settled at t=0) and pins the
    // element to unity — iOS ignores element.volume. Asserted on the resulting
    // param value rather than on spy call order (T-31: real value, not mirror).
    const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };

    expect(volumeGain.gain.value).toBe(0.2);
    expect(getLatestAudioElement().volume).toBe(1);
  });

  it("applies initial graph volume immediately for webaudio autoplay", async () => {
    player = new Player({ mode: "webaudio", autoplay: true, volume: 0.2 });

    await player.load({ data: createArrayBuffer() });

    // Volume is applied to the graph volume gain up front (setValueAtTime), so
    // the buffer starts already at the right level — asserted on the value.
    const outputGain = getLatestGainNode() as unknown as { gain: { value: number } };

    expect(outputGain.gain.value).toBe(0.2);
  });

  it("drives the graph volume gain toward the (clamped) target smoothly, not instantly (T-31)", async () => {
    vi.useFakeTimers();
    try {
      player = new Player({ mode: "html5", volume: 1 });
      await player.load("https://cdn.example.com/song.mp3");

      const volumeGain = getLatestGainNode() as unknown as {
        gain: { value: number };
      };

      // setVolume uses setTargetAtTime (smoothed): immediately after the call the
      // gain is still at the old value — smoothing is not instantaneous.
      player.setVolume(0.2);
      expect(volumeGain.gain.value).toBeGreaterThan(0.5);

      await advanceAudioTime(150);
      expect(volumeGain.gain.value).toBeCloseTo(0.2, 2);

      // Clamped targets land on the graph gain too (1.5 -> 1, -0.2 -> 0).
      player.setVolume(1.5);
      await advanceAudioTime(150);
      expect(player.volume).toBe(1);
      expect(volumeGain.gain.value).toBeCloseTo(1, 2);

      player.setVolume(-0.2);
      await advanceAudioTime(150);
      expect(player.volume).toBe(0);
      expect(volumeGain.gain.value).toBeCloseTo(0, 2);
    } finally {
      vi.useRealTimers();
    }
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

    vi.useFakeTimers();
    try {
      // setVolume behaves independently of the active fade multiplier: it drives
      // the volume gain (smoothed) and never touches the fade gain.
      player.setVolume(0.4);
      await advanceAudioTime(150);
      expect(volumeGain.gain.value).toBeCloseTo(0.4, 2);
      expect(fadeGain.gain.value).toBeCloseTo(0.3);
    } finally {
      vi.useRealTimers();
    }
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

  it("fadeOut (no pause/stop) leaves the fade multiplier at 0; volume alone cannot restore sound (mirror of F-13)", async () => {
    player = new Player({ mode: "html5", volume: 0.6 });
    await player.load("https://cdn.example.com/song.mp3");
    await player.play();

    await player.fadeOut(0); // instant fade to silence, playback continues

    const volumeGain = getLatestGainNode() as unknown as { gain: { value: number } };
    const fadeGain = getFadeGainNode() as unknown as { gain: { value: number } };

    // Faded out without pause/stop: the fade multiplier stays 0 (by design —
    // multiplier semantics, T-10) and is observable via fadeMultiplier.
    expect(player.state).toBe("playing");
    expect(player.fadeMultiplier).toBe(0);
    expect(fadeGain.gain.value).toBe(0);

    vi.useFakeTimers();
    try {
      // Raising volume moves volumeGain (smoothed) and player.volume, but the
      // effective output (fade × volume) stays silent — the mirror of F-13.
      player.setVolume(0.8);
      await advanceAudioTime(150);
      expect(player.volume).toBe(0.8);
      expect(volumeGain.gain.value).toBeCloseTo(0.8, 2);
      expect(fadeGain.gain.value).toBe(0);
      expect(player.fadeMultiplier).toBe(0);

      // fadeIn is the documented recovery: it ramps the multiplier back to full.
      await player.fadeIn(0);
      expect(player.fadeMultiplier).toBe(1);
      expect(fadeGain.gain.value).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
