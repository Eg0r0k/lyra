/**
 * Mocking strategy:
 * - `Player` is exercised in `webaudio` mode using the shared mocked
 *   `AudioContext`, gain/filter/analyser nodes, and a fake decoded buffer.
 * - `AudioGraph` is also tested directly so EQ and analyser behavior can be
 *   asserted without depending on Player orchestration for every branch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AudioGraph } from "../audio/AudioGraph";
import { Player } from "../index";
import {
  MockAudioContext,
  createArrayBuffer,
  getLatestAudioContext,
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

  it("player graph uses the shared audio context after load", async () => {
    player = new Player({ mode: "webaudio" });

    await player.load({ data: createArrayBuffer() });

    const graph = player.graph;
    expect(graph).not.toBeNull();
    expect(player.audioContext).toBe(getLatestAudioContext() as unknown as AudioContext);
    expect(graph?.bands).toHaveLength(10);
  });
});
