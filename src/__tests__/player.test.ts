/**
 * Mocking strategy:
 * - `Audio` is replaced with a controllable `MockAudioElement` so HTML5 loads,
 *   playback, seeks, and ended/timeupdate events can be driven without real media.
 * - `AudioContext` and all graph nodes are mocked so `Player.load()` can still
 *   build the Web Audio graph in both html5 and webaudio modes.
 * - `fetch` is mocked with `vi.fn()` to cover URL loading, headers, network
 *   failures, decode failures, and cancellation through `AbortSignal`.
 * - HLS is covered with a minimal in-test constructor mock that emits the
 *   `hls.js` events the library waits for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Player, HTML5Strategy, createVolume, createPlaybackRate } from "../index";
import type { HlsConstructor } from "../types";
import { PlayerErrorCode } from "../types/events";
import type { ISourceHandler } from "../source/ISourceHandler";
import { playerLogger } from "../utils/Logger";
import {
  MockAudioContext,
  MockAudioElement,
  MockMediaError,
  createArrayBuffer,
  createMockTimeStretch,
  createDeferred,
  fetchMock,
  getLatestAudioContext,
  getLatestAudioElement,
  getLatestGainNode,
  getLatestBufferSourceNode,
  mockFetchSuccess,
  setAudioAutoLoadCanPlay,
  setMockAudioDuration,
  setMockPitchVendor,
  setNativeHlsSupport,
  setNextAudioLoadError,
  setNextAudioPlayDeferred,
  setNextAudioPlayError,
} from "./test-utils";

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

  public static isSupported(): boolean {
    return true;
  }

  public currentLevel = -1;
  public levels = [
    { bitrate: 320_000, audioCodec: "aac" },
    { bitrate: 640_000, audioCodec: "aac" },
  ];

  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public loadSource(_url: string): void {
    queueMicrotask(() => {
      this.emit(MockHls.Events.MANIFEST_PARSED, undefined, {
        levels: this.levels,
      });
      this.emit(MockHls.Events.FRAG_BUFFERED);
    });
  }

  public attachMedia(element: HTMLMediaElement): void {
    queueMicrotask(() => {
      const audio = element as unknown as MockAudioElement;
      audio.readyState = 4;
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
    const callbacks = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
  }

  public off(event: string, callback: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(event);
    if (!callbacks) {
      return;
    }

    for (const callback of callbacks) {
      callback(...args);
    }
  }
}

describe("Player", () => {
  const players: Player[] = [];

  const trackPlayer = (player: Player): Player => {
    players.push(player);
    return player;
  };

  afterEach(async () => {
    while (players.length > 0) {
      const player = players.pop();
      if (player) {
        await player.dispose();
      }
    }
  });

  beforeEach(() => {
    setMockAudioDuration(180);
  });

  describe("factory methods", () => {
    it("creates valid instances with Player.auto, Player.forMusic, and Player.forStreaming", async () => {
      const autoPlayer = trackPlayer(Player.auto());
      const musicPlayer = trackPlayer(Player.forMusic());
      const streamingPlayer = trackPlayer(Player.forStreaming());

      expect(autoPlayer).toBeInstanceOf(Player);
      expect(musicPlayer).toBeInstanceOf(Player);
      expect(streamingPlayer).toBeInstanceOf(Player);

      expect(autoPlayer.state).toBe("idle");
      expect(musicPlayer.state).toBe("idle");
      expect(streamingPlayer.state).toBe("idle");

      await musicPlayer.load({ data: createArrayBuffer() });
      await streamingPlayer.load("https://cdn.example.com/stream.mp3");

      expect(musicPlayer.mode).toBe("webaudio");
      expect(streamingPlayer.mode).toBe("html5");
    });

    it("applies constructor config to exposed getters", () => {
      const player = trackPlayer(
        new Player({
          mode: "webaudio",
          volume: 0.25,
          playbackRate: 1.5,
          loop: true,
          muted: true,
        }),
      );

      expect(player.mode).toBe("auto");
      expect(player.volume).toBe(0.25);
      expect(player.playbackRate).toBe(1.5);
      expect(player.loop).toBe(true);
      expect(player.muted).toBe(true);
      expect(player.state).toBe("idle");
      expect(player.isReady).toBe(false);
      expect(player.isPlaying).toBe(false);
      expect(player.isFading).toBe(false);
    });
  });

  describe("load", () => {
    it("loads a plain URL string", async () => {
      const player = trackPlayer(Player.auto());

      await player.load("https://cdn.example.com/song.mp3");

      expect(player.state).toBe("ready");
      expect(player.mode).toBe("html5");
      expect(player.duration).toBe(180);
      expect(getLatestAudioElement().src).toBe("https://cdn.example.com/song.mp3");
    });

    it("loads File and Blob sources through object URLs", async () => {
      const filePlayer = trackPlayer(Player.auto());
      const blobPlayer = trackPlayer(Player.auto());
      const file = new File(["mock"], "song.mp3", { type: "audio/mpeg" });
      const blob = new Blob(["mock"], { type: "audio/mpeg" });

      await filePlayer.load(file);
      expect(filePlayer.state).toBe("ready");
      expect(getLatestAudioElement().src).toBe("blob:mock-1");

      await blobPlayer.load(blob);
      expect(blobPlayer.state).toBe("ready");
      expect(getLatestAudioElement().src).toBe("blob:mock-2");
    });

    it("loads ArrayBuffer data through the Web Audio strategy", async () => {
      const player = trackPlayer(Player.auto());

      await player.load({ data: createArrayBuffer() });

      expect(player.state).toBe("ready");
      expect(player.mode).toBe("webaudio");
      expect(player.duration).toBe(120);
    });

    it("passes custom headers when loading a URL in webaudio mode", async () => {
      mockFetchSuccess();
      const player = trackPlayer(new Player({ mode: "webaudio" }));

      await player.load({
        url: "https://api.example.com/audio/42",
        headers: { Authorization: "Bearer token" },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.com/audio/42",
        expect.objectContaining({
          headers: { Authorization: "Bearer token" },
          mode: "cors",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(player.mode).toBe("webaudio");
    });

    it("loads an HLS source when an Hls constructor is provided", async () => {
      const player = trackPlayer(
        new Player({
          Hls: MockHls as unknown as HlsConstructor,
        }),
      );

      await player.load({
        url: "https://cdn.example.com/live/stream.m3u8",
        type: "hls",
      });

      expect(player.state).toBe("ready");
      expect(player.mode).toBe("html5");
      expect(player.getQualityLevels()).toHaveLength(2);
    });

    it("cancels a previous unfinished load when a new load starts", async () => {
      const firstResponse = createDeferred<Response>();
      const secondResponse = createDeferred<Response>();
      const firstAbort = vi.fn();

      fetchMock.mockImplementationOnce(((_input: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          firstAbort();
          firstResponse.reject(new DOMException("Aborted", "AbortError"));
        });

        return firstResponse.promise;
      }) as typeof fetch);

      fetchMock.mockImplementationOnce((() => secondResponse.promise) as typeof fetch);

      const player = trackPlayer(new Player({ mode: "webaudio" }));
      const firstLoad = player.load({ url: "https://cdn.example.com/slow.mp3" });

      await Promise.resolve();

      const secondLoad = player.load({ url: "https://cdn.example.com/fast.mp3" });

      await vi.waitFor(() => {
        expect(firstAbort).toHaveBeenCalledTimes(1);
      });

      secondResponse.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => createArrayBuffer(),
      } as Response);

      await expect(secondLoad).resolves.toBeUndefined();
      await expect(firstLoad).resolves.toBeUndefined();
      expect(firstAbort).toHaveBeenCalledTimes(1);
      expect(player.state).toBe("ready");
      expect(player.mode).toBe("webaudio");
    });

    it("throws LOAD_NETWORK on fetch failure", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response);
      const player = trackPlayer(new Player({ mode: "webaudio" }));

      await expect(
        player.load({ url: "https://cdn.example.com/broken.mp3" }),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_NETWORK });
      expect(player.state).toBe("error");
    });

    it("maps rejected fetch network errors to LOAD_NETWORK", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      const player = trackPlayer(new Player({ mode: "webaudio" }));

      await expect(
        player.load({ url: "https://cdn.example.com/offline.mp3" }),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_NETWORK });
      expect(player.state).toBe("error");
    });

    it("throws LOAD_DECODE when decodeAudioData fails", async () => {
      mockFetchSuccess();
      MockAudioContext.decodeError = new Error("decode failed");
      const player = trackPlayer(new Player({ mode: "webaudio" }));

      await expect(
        player.load({ url: "https://cdn.example.com/decode.mp3" }),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_DECODE });
      expect(player.state).toBe("error");
    });

    it("throws LOAD_NOT_SUPPORTED for HLS without an Hls constructor", async () => {
      const player = trackPlayer(Player.auto());

      await expect(
        player.load({ url: "https://cdn.example.com/live/stream.m3u8", type: "hls" }),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_NOT_SUPPORTED });
      expect(player.state).toBe("error");
    });

    it("plays an HLS URL via the native html5 element when hls.js is absent", async () => {
      setNativeHlsSupport(true);
      const player = trackPlayer(Player.auto());

      await player.load({
        url: "https://cdn.example.com/live/stream.m3u8",
        type: "hls",
      });

      expect(player.state).toBe("ready");
      expect(player.mode).toBe("html5");
      expect(getLatestAudioElement().src).toBe(
        "https://cdn.example.com/live/stream.m3u8",
      );
    });

    it("maps HTML5 media network errors to LOAD_NETWORK instead of format errors", async () => {
      setNextAudioLoadError(
        new MockMediaError(MockMediaError.MEDIA_ERR_NETWORK, "network failed"),
      );
      const player = trackPlayer(Player.auto());

      await expect(
        player.load("https://cdn.example.com/offline.mp3"),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_NETWORK });
      expect(player.state).toBe("error");
    });

    it("maps HTML5 unsupported media errors to LOAD_NOT_SUPPORTED", async () => {
      setNextAudioLoadError(
        new MockMediaError(
          MockMediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
          "unsupported format",
        ),
      );
      const player = trackPlayer(Player.auto());

      await expect(
        player.load("https://cdn.example.com/file.weird"),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_NOT_SUPPORTED });
      expect(player.state).toBe("error");
    });
  });

  describe("playback controls and getters", () => {
    it("plays, pauses, stops, and toggles playback", async () => {
      const player = trackPlayer(Player.auto());

      await player.load("https://cdn.example.com/song.mp3");
      await player.play();
      expect(player.state).toBe("playing");
      expect(player.isPlaying).toBe(true);

      player.pause();
      expect(player.state).toBe("paused");
      expect(player.isPlaying).toBe(false);

      await player.togglePlay();
      expect(player.state).toBe("playing");

      player.stop();
      expect(player.state).toBe("ready");
      expect(player.currentTime).toBe(0);
      expect(player.isPlaying).toBe(false);
    });

    it("seeks by seconds and by percentage with clamping", async () => {
      setMockAudioDuration(200);
      const player = trackPlayer(Player.auto());

      await player.load("https://cdn.example.com/song.mp3");

      player.seek(50);
      expect(player.currentTime).toBe(50);

      player.seekPercent(0.5);
      expect(player.currentTime).toBe(100);

      player.seekPercent(2);
      expect(player.currentTime).toBe(200);

      player.seek(-10);
      expect(player.currentTime).toBe(0);
    });

    it("updates volume, mute, playback rate, loop, and derived getters", async () => {
      const player = trackPlayer(Player.auto());

      await player.load("https://cdn.example.com/song.mp3");

      // Routed html5 (default): user volume/mute live on the graph volume gain;
      // the element is pinned to unity (T-10 / F-11).
      player.setVolume(1.5);
      expect(player.volume).toBe(1);
      expect(getLatestGainNode().gain.value).toBe(1);
      expect(getLatestAudioElement().volume).toBe(1);

      player.setVolume(-0.2);
      expect(player.volume).toBe(0);
      expect(getLatestGainNode().gain.value).toBe(0);
      expect(getLatestAudioElement().volume).toBe(1);

      player.setMuted(true);
      expect(player.muted).toBe(true);
      expect(getLatestGainNode().gain.value).toBe(0);
      expect(getLatestAudioElement().muted).toBe(false);

      player.toggleMute();
      expect(player.muted).toBe(false);
      expect(getLatestAudioElement().muted).toBe(false);

      player.setPlaybackRate(32);
      expect(player.playbackRate).toBe(16);

      player.setPlaybackRate(0); // finite → clamps into [0.0625, 16] (F-26)
      expect(player.playbackRate).toBe(0.0625);

      player.setPlaybackRate(NaN); // non-finite → safe default 1
      expect(player.playbackRate).toBe(1);

      player.setLoop(true);
      expect(player.loop).toBe(true);
      expect(getLatestAudioElement().loop).toBe(true);

      expect(player.state).toBe("ready");
      expect(player.duration).toBe(180);
      expect(player.currentTime).toBe(0);
      expect(player.isReady).toBe(true);
      expect(player.isFading).toBe(false);
      expect(player.mode).toBe("html5");
    });
  });

  describe("stale-load safety and signal threading (T-01)", () => {
    it("keeps the player clean when a second load supersedes an in-flight html5 initialize", async () => {
      setAudioAutoLoadCanPlay(false);

      const player = trackPlayer(Player.auto());
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      const loadA = player.load("https://cdn.example.com/a.mp3");

      await vi.waitFor(() => {
        expect(getLatestAudioElement().src).toBe("https://cdn.example.com/a.mp3");
      });

      setAudioAutoLoadCanPlay(true);

      const loadB = player.load("https://cdn.example.com/b.mp3");

      await expect(loadB).resolves.toBeUndefined();
      await expect(loadA).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(player.state).toBe("ready");
    });

    it("rejects initialize with AbortError when the load signal aborts", async () => {
      setAudioAutoLoadCanPlay(false);

      const strategy = new HTML5Strategy();
      const controller = new AbortController();

      const init = strategy.initialize({
        sourceUrl: "https://cdn.example.com/a.mp3",
        audioContext: new AudioContext(),
        volume: createVolume(1),
        muted: false,
        playbackRate: createPlaybackRate(1),
        loop: false,
        preservesPitch: true,
        preload: "auto",
        signal: controller.signal,
      });

      controller.abort();

      await expect(init).rejects.toMatchObject({ name: "AbortError" });

      strategy.dispose();
    });

    it("swallows a stale webaudio decode rejection", async () => {
      const decodeA = createDeferred<AudioBuffer>();
      MockAudioContext.nextDecodeDeferred = decodeA.promise;

      const player = trackPlayer(new Player({ mode: "webaudio" }));
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      const loadA = player.load({ data: createArrayBuffer() });

      await vi.waitFor(() => {
        expect(MockAudioContext.nextDecodeDeferred).toBeNull();
      });

      const loadB = player.load({ data: createArrayBuffer() });
      await expect(loadB).resolves.toBeUndefined();

      decodeA.reject(new Error("late decode failure"));
      await expect(loadA).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(player.state).toBe("ready");
    });

    it("aborts the only in-flight load silently and rolls back", async () => {
      // No public API cancels the *current* load while keeping the player
      // alive: load() again makes the prior load stale (not current), and
      // _cancellation is private. dispose() is the only public path that
      // aborts the current load, so it is used here to exercise the
      // isCurrentLoad()+AbortError branch. The transient "idle" transition is
      // immediately superseded by "disposed"; we assert the abort is silent.
      setAudioAutoLoadCanPlay(false);

      const player = trackPlayer(Player.auto());
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      const load = player.load("https://cdn.example.com/a.mp3");

      await vi.waitFor(() => {
        expect(getLatestAudioElement().src).toBe("https://cdn.example.com/a.mp3");
      });

      await player.dispose();
      await expect(load).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("autoplay decoupling and play-generation guard (T-02)", () => {
    it("resolves load with a single error when autoplay is blocked", async () => {
      setNextAudioPlayError(new DOMException("Autoplay blocked", "NotAllowedError"));

      const player = trackPlayer(new Player({ autoplay: true }));
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      await expect(
        player.load("https://cdn.example.com/song.mp3"),
      ).resolves.toBeUndefined();

      expect(player.state).toBe("ready");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: PlayerErrorCode.PLAYBACK_NOT_ALLOWED }),
      );
    });

    it("ignores a play() that resolves after a newer load()", async () => {
      const player = trackPlayer(Player.auto());
      await player.load("https://cdn.example.com/a.mp3");

      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      const playGate = createDeferred<void>();
      setNextAudioPlayDeferred(playGate.promise);

      const elementA = getLatestAudioElement();
      const playPromise = player.play();

      await vi.waitFor(() => {
        expect(elementA.playPending).toBe(true);
      });

      const loadB = player.load("https://cdn.example.com/b.mp3");
      await expect(loadB).resolves.toBeUndefined();

      playGate.resolve();
      await expect(playPromise).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(player.state).toBe("ready");
    });

    it("rethrows PLAYBACK_NOT_ALLOWED to the caller on manual play", async () => {
      const player = trackPlayer(Player.auto());
      await player.load("https://cdn.example.com/song.mp3");

      setNextAudioPlayError(new DOMException("blocked", "NotAllowedError"));
      const errorSpy = vi.fn();
      player.on("error", errorSpy);

      await expect(player.play()).rejects.toMatchObject({
        code: PlayerErrorCode.PLAYBACK_NOT_ALLOWED,
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(player.state).toBe("ready");
    });
  });

  describe("web audio routing policy + CORS (T-04)", () => {
    it("webAudioRouting:'never' html5 load creates no AudioContext and graph is null", async () => {
      const player = trackPlayer(
        new Player({ mode: "html5", webAudioRouting: "never" }),
      );

      await player.load("https://cdn.example.com/song.mp3");

      expect(player.state).toBe("ready");
      expect(MockAudioContext.instances).toHaveLength(0);
      expect(player.graph).toBeNull();
      expect(getLatestAudioElement().crossOrigin).toBeNull();

      await player.play();
      expect(player.isPlaying).toBe(true);
      expect(MockAudioContext.instances).toHaveLength(0);
    });

    it("does not set crossOrigin for a same-origin URL (default routing)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));

      await player.load(`${window.location.origin}/song.mp3`);

      expect(getLatestAudioElement().crossOrigin).toBeNull();
    });

    it("sets crossOrigin=anonymous for a cross-origin URL when routing (out of the box)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));

      await player.load("https://cdn.example.com/song.mp3");

      expect(getLatestAudioElement().crossOrigin).toBe("anonymous");
      expect(player.graph).not.toBeNull();
    });

    it("corsFallback retries a cross-origin media error without crossOrigin and disables the graph", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      setNextAudioLoadError(
        new MockMediaError(MockMediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, "cors"),
      );

      const player = trackPlayer(
        new Player({ mode: "html5", corsFallback: true }),
      );

      await player.load("https://cdn.example.com/song.mp3");

      expect(player.state).toBe("ready");
      expect(getLatestAudioElement().crossOrigin).toBeNull();
      expect(player.graph).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining("crossOrigin"),
      );

      warnSpy.mockRestore();
    });

    it("without corsFallback a cross-origin media error surfaces with no retry", async () => {
      setNextAudioLoadError(
        new MockMediaError(MockMediaError.MEDIA_ERR_NETWORK, "net"),
      );

      const player = trackPlayer(new Player({ mode: "html5" }));

      await expect(
        player.load("https://cdn.example.com/song.mp3"),
      ).rejects.toMatchObject({ code: PlayerErrorCode.LOAD_NETWORK });
      expect(player.state).toBe("error");
    });

    it("per-load webAudioRouting:'never' overrides the constructor 'always'", async () => {
      const player = trackPlayer(new Player({ mode: "html5" })); // default 'always'

      await player.load("https://cdn.example.com/song.mp3", {
        webAudioRouting: "never",
      });

      expect(player.state).toBe("ready");
      expect(player.graph).toBeNull();
      expect(MockAudioContext.instances).toHaveLength(0);
      expect(getLatestAudioElement().crossOrigin).toBeNull();
    });

    it("per-load webAudioRouting:'always' overrides the constructor 'never'", async () => {
      const player = trackPlayer(
        new Player({ mode: "html5", webAudioRouting: "never" }),
      );

      await player.load("https://cdn.example.com/song.mp3", {
        webAudioRouting: "always",
      });

      expect(player.state).toBe("ready");
      expect(player.graph).not.toBeNull();
      expect(getLatestAudioElement().crossOrigin).toBe("anonymous");
    });

    it("resolves a mixed playlist per track (F-02): routed then un-routed on one player", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));

      // Track A: CORS source with the graph.
      await player.load("https://cdn.example.com/cors.mp3", {
        webAudioRouting: "always",
      });
      expect(player.graph).not.toBeNull();
      expect(getLatestAudioElement().crossOrigin).toBe("anonymous");

      // Track B: non-CORS source without the graph, same player.
      await player.load("https://cdn.example.com/no-cors.mp3", {
        webAudioRouting: "never",
      });
      expect(player.graph).toBeNull();
      expect(getLatestAudioElement().crossOrigin).toBeNull();
    });
  });

  describe("buffering controls + FSM completeness (T-08)", () => {
    it("pause during buffering transitions to paused (F-10)", async () => {
      const player = trackPlayer(Player.auto());
      await player.load("https://cdn.example.com/song.mp3");
      await player.play();

      getLatestAudioElement().emitWaiting();
      expect(player.state).toBe("buffering");

      player.pause();
      expect(player.state).toBe("paused");
    });

    it("togglePlay during buffering pauses instead of double-playing (F-10)", async () => {
      const player = trackPlayer(Player.auto());
      await player.load("https://cdn.example.com/song.mp3");
      await player.play();

      getLatestAudioElement().emitWaiting();
      expect(player.state).toBe("buffering");

      await player.togglePlay();
      expect(player.state).toBe("paused");
    });

    it("waiting while ready enters buffering without an FSM warning (F-34)", async () => {
      const player = trackPlayer(Player.auto());
      await player.load("https://cdn.example.com/song.mp3");
      expect(player.state).toBe("ready");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      getLatestAudioElement().emitWaiting();

      expect(player.state).toBe("buffering");
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining("Invalid state transition"),
      );

      warnSpy.mockRestore();
    });

    it("waiting after resume from paused enters buffering (F-34)", async () => {
      const player = trackPlayer(Player.auto());
      await player.load("https://cdn.example.com/song.mp3");
      await player.play();
      player.pause();
      expect(player.state).toBe("paused");

      getLatestAudioElement().emitWaiting();
      expect(player.state).toBe("buffering");
    });
  });

  describe("html5 readiness waiter (T-09)", () => {
    it("url load times out with LOAD_NETWORK", async () => {
      vi.useFakeTimers();
      try {
        setAudioAutoLoadCanPlay(false); // element never fires canplay/error
        const player = trackPlayer(new Player({ mode: "html5" }));

        const load = player.load("https://cdn.example.com/stall.mp3");
        const rejection = expect(load).rejects.toMatchObject({
          code: PlayerErrorCode.LOAD_NETWORK,
        });

        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;

        expect(player.state).toBe("error");
      } finally {
        vi.useRealTimers();
      }
    });

    it("readiness timeout cleans up listeners and the timer", async () => {
      vi.useFakeTimers();
      try {
        setAudioAutoLoadCanPlay(false);
        const player = trackPlayer(new Player({ mode: "html5" }));

        const load = player.load("https://cdn.example.com/stall.mp3");
        const rejection = expect(load).rejects.toMatchObject({
          code: PlayerErrorCode.LOAD_NETWORK,
        });

        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;

        // Timer fired and was cleared — no leftover readiness timer.
        expect(vi.getTimerCount()).toBe(0);

        // Late readiness/error events are inert: the waiter's listeners are gone.
        const element = getLatestAudioElement();
        element.dispatchEvent(new Event("canplay"));
        element.dispatchEvent(new Event("error"));
        expect(player.state).toBe("error");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("unlockAudio + context auto-resume (T-11)", () => {
    it("resolves on a running context", async () => {
      const player = trackPlayer(Player.auto());

      await expect(player.unlockAudio()).resolves.toBeUndefined();

      const ctx = getLatestAudioContext();
      expect(ctx.createdBufferSources).toHaveLength(1);
    });

    it("rejects on a stuck-suspended context and releases the latch", async () => {
      vi.useFakeTimers();
      try {
        const player = trackPlayer(Player.auto());

        // Force the context to stay suspended: resume() never flips state.
        // Accessing `.audioContext` creates the context (running); suspend it.
        const ctx = player.audioContext as unknown as MockAudioContext;
        ctx.setState("suspended");
        MockAudioContext.resumeKeepsState = true;

        const first = player.unlockAudio();
        const rejection = expect(first).rejects.toMatchObject({
          code: PlayerErrorCode.PLAYBACK_NOT_ALLOWED,
        });
        await vi.advanceTimersByTimeAsync(2_000);
        await rejection;

        // Latch released → a later call retries. Let resume succeed now.
        MockAudioContext.resumeKeepsState = false;
        await expect(player.unlockAudio()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("contains a rejected auto-resume in the interrupted→suspended path", async () => {
      const player = trackPlayer(Player.auto());

      // Create the context (running) and install the statechange handler.
      const ctx = player.audioContext as unknown as MockAudioContext;

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        MockAudioContext.resumeError = new Error("resume blocked (no gesture)");

        ctx.setState("interrupted");
        ctx.setState("suspended"); // triggers auto-resume → resume() rejects

        // Node reports unhandled rejections on a macrotask boundary, which
        // fake timers do not trigger — a real macrotask flush is the only way
        // to observe (the absence of) the process-level event. Executor form
        // is used because the repo's ES2020 lib predates Promise.withResolvers.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

        expect(unhandled).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        MockAudioContext.resumeError = null;
      }
    });

    it("unlock state resets after context recreation", async () => {
      const player = trackPlayer(Player.auto());

      await player.unlockAudio();
      const first = getLatestAudioContext();

      // Closing the context forces getAudioContext() to recreate it.
      first.setState("closed");
      await player.getAudioContext();

      const recreated = getLatestAudioContext();
      expect(recreated).not.toBe(first);
      expect(recreated.createdBufferSources).toHaveLength(0);

      // Latch was cleared on recreation → unlockAudio runs again.
      await player.unlockAudio();
      expect(recreated.createdBufferSources).toHaveLength(1);
    });

    it("does not leak statechange listeners across repeated failed unlocks", async () => {
      vi.useFakeTimers();
      try {
        const player = trackPlayer(Player.auto());
        const ctx = player.audioContext as unknown as MockAudioContext;
        ctx.setState("suspended");
        MockAudioContext.resumeKeepsState = true;

        // Baseline = the player's own persistent statechange listener (T-19,
        // registered via addEventListener). unlockAudio's transient listeners
        // must not accumulate on top of it.
        const baseline = ctx.statechangeListenerCount;

        for (let i = 0; i < 3; i++) {
          const attempt = player.unlockAudio();
          const rejection = expect(attempt).rejects.toMatchObject({
            code: PlayerErrorCode.PLAYBACK_NOT_ALLOWED,
          });
          await vi.advanceTimersByTimeAsync(2_000);
          await rejection;
        }

        // Every settle path (incl. timeout) removes its transient listener.
        expect(ctx.statechangeListenerCount).toBe(baseline);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("loudness metadata reset on load (T-12)", () => {
    it("resets normalization gain to 0 dB on a new load and fires normalizationchange", async () => {
      const player = trackPlayer(
        new Player({
          mode: "html5",
          loudnessNormalization: { enabled: true, targetLufs: -16 },
        }),
      );

      await player.load("https://cdn.example.com/a.mp3");
      player.setLoudnessMetadata({ integratedLufs: -22 }); // +6 dB
      expect(player.getAppliedNormalizationGainDb()).toBe(6);

      const events: { enabled: boolean; gainDb: number }[] = [];
      player.on("normalizationchange", (e) => events.push(e));

      await player.load("https://cdn.example.com/b.mp3");

      expect(player.loudnessMetadata).toBeNull();
      expect(player.getAppliedNormalizationGainDb()).toBe(0);
      expect(events.some((e) => e.enabled === false && e.gainDb === 0)).toBe(
        true,
      );
    });

    it("retains metadata across loads when retainMetadataAcrossLoads is set", async () => {
      const player = trackPlayer(
        new Player({
          mode: "html5",
          loudnessNormalization: {
            enabled: true,
            targetLufs: -16,
            retainMetadataAcrossLoads: true,
          },
        }),
      );

      await player.load("https://cdn.example.com/a.mp3");
      player.setLoudnessMetadata({ integratedLufs: -22 }); // +6 dB
      expect(player.getAppliedNormalizationGainDb()).toBe(6);

      await player.load("https://cdn.example.com/b.mp3");

      // Metadata survives and is recomputed/re-applied for the new track.
      expect(player.loudnessMetadata).toEqual({ integratedLufs: -22 });
      expect(player.getAppliedNormalizationGainDb()).toBe(6);
    });
  });

  describe("explicit mode vs handler preference (T-13)", () => {
    it("explicit html5 mode plays an ArrayBuffer via blob URL (F-14)", async () => {
      // BufferHandler.preferredStrategy() is 'webaudio' but has no
      // requiredStrategy, so an explicit html5 mode must win.
      const player = trackPlayer(new Player({ mode: "html5" }));

      await player.load({ data: createArrayBuffer() });

      expect(player.mode).toBe("html5");
    });

    it("HLS still overrides an explicit webaudio mode (with a warning)", async () => {
      const warn = vi.spyOn(playerLogger, "warn");
      const player = trackPlayer(
        new Player({
          mode: "webaudio",
          Hls: MockHls as unknown as HlsConstructor,
        }),
      );

      await player.load({
        url: "https://cdn.example.com/live/stream.m3u8",
        type: "hls",
      });

      expect(player.mode).toBe("html5"); // requiredStrategy('html5') wins
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("switching from webaudio"),
      );
      warn.mockRestore();
    });

    it("honors explicit mode and never calls requiredStrategy on a custom handler that omits it", async () => {
      // The class that fails silently: an external handler registered via
      // registerHandler that does NOT implement requiredStrategy. The optional
      // call must not throw, and its 'webaudio' preference must not override
      // the explicit html5 mode.
      const customHandler: ISourceHandler = {
        id: "custom-test",
        canHandle: (s) => s.url === "https://custom.example.com/x.mp3",
        preferredStrategy: () => "webaudio",
        prepare: async (source, strategy) =>
          strategy.id === "webaudio"
            ? { audioBuffer: { duration: 1 } as AudioBuffer, duration: 1 }
            : { sourceUrl: source.url as string, duration: 1 },
        getCapabilities: () => null,
        dispose: () => undefined,
      };

      const explicit = trackPlayer(new Player({ mode: "html5" }));
      explicit.registerHandler(customHandler);

      await explicit.load("https://custom.example.com/x.mp3");

      // Explicit html5 respected despite the handler's 'webaudio' preference.
      expect(explicit.mode).toBe("html5");

      // In auto mode, preferredStrategy still works as the selection hint.
      const auto = trackPlayer(new Player({ mode: "auto" }));
      auto.registerHandler(customHandler);

      await auto.load("https://custom.example.com/x.mp3");

      expect(auto.mode).toBe("webaudio");
    });
  });

  describe("handler lifecycle: reset vs dispose (T-14)", () => {
    const makeHandler = (
      reset: () => void,
      dispose: () => void,
    ): ISourceHandler => ({
      id: "lifecycle-test",
      canHandle: (s) => s.url === "https://custom.example.com/x.mp3",
      preferredStrategy: () => "any",
      prepare: async (source) => ({
        sourceUrl: source.url as string,
        duration: 1,
      }),
      getCapabilities: () => null,
      reset,
      dispose,
    });

    it("resets the reused handler between loads and never disposes it per load (F-15)", async () => {
      const reset = vi.fn();
      const dispose = vi.fn();
      const player = trackPlayer(new Player({ mode: "html5" }));
      player.registerHandler(makeHandler(reset, dispose));

      await player.load("https://custom.example.com/x.mp3");
      await player.load("https://custom.example.com/x.mp3");

      // Second load's cleanup reset the reused handler; dispose is terminal only.
      expect(reset).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    });

    it("never disposes a registered handler; the caller owns it (F-14 ownership)", async () => {
      const reset = vi.fn();
      const dispose = vi.fn();
      const player = new Player({ mode: "html5" });
      player.registerHandler(makeHandler(reset, dispose));

      await player.load("https://custom.example.com/x.mp3");
      await player.dispose();

      // Registered handlers are caller-owned — the player disposes only its
      // own built-ins, so the consumer's object survives player.dispose().
      expect(dispose).not.toHaveBeenCalled();
    });

    it("a handler shared across two players survives disposing the first", async () => {
      const reset = vi.fn();
      const dispose = vi.fn();
      const shared = makeHandler(reset, dispose);

      const first = new Player({ mode: "html5" });
      const second = trackPlayer(new Player({ mode: "html5" }));
      first.registerHandler(shared);
      second.registerHandler(shared);

      await first.load("https://custom.example.com/x.mp3");
      await first.dispose();

      // The shared handler was not disposed, so the second player still uses it.
      expect(dispose).not.toHaveBeenCalled();
      await second.load("https://custom.example.com/x.mp3");
      expect(second.state).toBe("ready");
    });

    it("registerHandler makes a custom handler reachable through the player (F-37)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));
      const prepare = vi.fn(async (source: { url?: string }) => ({
        sourceUrl: source.url as string,
        duration: 1,
      }));

      player.registerHandler({
        id: "reachable-test",
        canHandle: (s) => s.url === "https://custom.example.com/x.mp3",
        preferredStrategy: () => "any",
        prepare: prepare as ISourceHandler["prepare"],
        getCapabilities: () => null,
        dispose: () => undefined,
      });

      await player.load("https://custom.example.com/x.mp3");

      expect(prepare).toHaveBeenCalledTimes(1);
      expect(player.state).toBe("ready");
    });
  });

  describe("preservesPitch (T-23)", () => {
    it("html5 initialize sets preservesPitch on the element (default true)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));
      await player.load("https://cdn.example.com/song.mp3");

      const el = getLatestAudioElement() as MockAudioElement & {
        preservesPitch?: boolean;
      };
      expect(el.preservesPitch).toBe(true);
      expect(player.preservesPitch).toBe(true);
      expect(player.canPreservePitch).toBe(true);
    });

    it("setPreservesPitch(false) applies to the live element immediately (toggle while playing)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));
      await player.load("https://cdn.example.com/song.mp3");
      await player.play();

      const el = getLatestAudioElement() as MockAudioElement & {
        preservesPitch?: boolean;
      };
      expect(el.preservesPitch).toBe(true);

      player.setPreservesPitch(false);

      // Applied to the ALREADY-loaded element now — not deferred to next load.
      expect(el.preservesPitch).toBe(false);
      expect(player.preservesPitch).toBe(false);
    });

    it("falls back to the webkit vendor property when the standard one is absent", async () => {
      setMockPitchVendor("webkit");
      const player = trackPlayer(
        new Player({ mode: "html5", preservesPitch: false }),
      );
      await player.load("https://cdn.example.com/song.mp3");

      const el = getLatestAudioElement() as MockAudioElement & {
        preservesPitch?: boolean;
        webkitPreservesPitch?: boolean;
      };
      expect("preservesPitch" in el).toBe(false);
      expect(el.webkitPreservesPitch).toBe(false);
      expect(player.canPreservePitch).toBe(true);
    });

    it("reports canPreservePitch=false in webaudio mode", async () => {
      const player = trackPlayer(new Player({ mode: "webaudio" }));
      await player.load({ data: createArrayBuffer() });

      expect(player.canPreservePitch).toBe(false);
    });

    it("webaudio warns once when pitch preservation is requested with rate != 1", async () => {
      const warn = vi.spyOn(playerLogger, "warn");
      const player = trackPlayer(
        new Player({ mode: "webaudio", preservesPitch: true, playbackRate: 1.5 }),
      );
      await player.load({ data: createArrayBuffer() });

      // A further rate change must not re-warn (latched).
      player.setPlaybackRate(2);

      const pitchWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("preservesPitch requested"),
      );
      expect(pitchWarnings).toHaveLength(1);
      warn.mockRestore();
    });
  });

  describe("seek/timeupdate parity (T-18)", () => {
    it("webaudio seek emits seeked with no pause/play flicker (F-22)", async () => {
      const player = trackPlayer(new Player({ mode: "webaudio" }));
      await player.load({ data: createArrayBuffer() });
      await player.play();

      const events: string[] = [];
      player.on("pause", () => events.push("pause"));
      player.on("play", () => events.push("play"));
      player.on("seeked", () => events.push("seeked"));

      player.seek(1);

      // The internal pause/play restart is suppressed — a seek is not a
      // pause/resume. Only seeked surfaces (seeking is asserted separately).
      expect(events).toEqual(["seeked"]);
    });

    it("html5 seeked fires from the native element event, not synchronously (F-28)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));
      await player.load("https://cdn.example.com/song.mp3");

      const seeked = vi.fn();
      player.on("seeked", seeked);

      player.seek(50);
      expect(seeked).not.toHaveBeenCalled(); // not emitted synchronously

      getLatestAudioElement().dispatchEvent(new Event("seeked"));
      expect(seeked).toHaveBeenCalledWith(50); // driven by the native event
    });

    it("does not clamp a seek to 0 when duration is unknown (F-28)", async () => {
      const player = trackPlayer(new Player({ mode: "html5" }));
      await player.load("https://cdn.example.com/song.mp3");

      const el = getLatestAudioElement();
      el.duration = NaN; // metadata not yet known

      player.seek(30);
      expect(el.currentTime).toBe(30); // lower clamp only, not forced to 0
    });

    it("webaudio timeupdate ticks via a ~250ms timer, not rAF (F-28)", async () => {
      vi.useFakeTimers();
      try {
        const player = trackPlayer(new Player({ mode: "webaudio" }));
        await player.load({ data: createArrayBuffer() });
        await player.play();

        const tu = vi.fn();
        player.on("timeupdate", tu);

        await vi.advanceTimersByTimeAsync(250);
        expect(tu).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(500);
        expect(tu.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("injectable AudioContext (T-19)", () => {
    it("does not close an injected context on dispose (F-23)", async () => {
      const ctx = new MockAudioContext();
      const player = new Player({
        mode: "webaudio",
        audioContext: ctx as unknown as AudioContext,
      });

      await player.load({ data: createArrayBuffer() });
      await player.dispose();

      expect(ctx.state).not.toBe("closed"); // caller owns it
    });

    it("closes an owned context on dispose (regression)", async () => {
      const player = new Player({ mode: "webaudio" });
      await player.load({ data: createArrayBuffer() });

      const ctx = getLatestAudioContext();
      await player.dispose();

      expect(ctx.state).toBe("closed");
    });

    it("two players share one injected context; disposing one leaves it open", async () => {
      const ctx = new MockAudioContext();
      const a = new Player({
        mode: "webaudio",
        audioContext: ctx as unknown as AudioContext,
      });
      const b = trackPlayer(
        new Player({
          mode: "webaudio",
          audioContext: ctx as unknown as AudioContext,
        }),
      );

      await a.load({ data: createArrayBuffer() });
      await b.load({ data: createArrayBuffer() });
      await a.dispose();

      expect(ctx.state).not.toBe("closed");
      // b still works on the shared context.
      await b.play();
      expect(b.isPlaying).toBe(true);
    });

    it("throws PLAYBACK_FAILED when the injected context is already closed", async () => {
      const ctx = new MockAudioContext();
      await ctx.close();
      const player = trackPlayer(
        new Player({
          mode: "webaudio",
          audioContext: ctx as unknown as AudioContext,
        }),
      );

      const read = () => player.audioContext;
      let caught: { code?: PlayerErrorCode } | undefined;
      try {
        read();
      } catch (e) {
        caught = e as { code?: PlayerErrorCode };
      }
      expect(caught?.code).toBe(PlayerErrorCode.PLAYBACK_FAILED);
    });

    it("preserves a consumer's onstatechange on an injected context (T-19 positive)", async () => {
      const ctx = new MockAudioContext();
      const consumerHandler = vi.fn();
      ctx.onstatechange = consumerHandler as unknown as typeof ctx.onstatechange;

      const player = trackPlayer(
        new Player({
          mode: "webaudio",
          audioContext: ctx as unknown as AudioContext,
        }),
      );
      await player.load({ data: createArrayBuffer() });

      const resumed = vi.fn();
      player.on("contextresumed", resumed);

      // The player observes statechange via addEventListener; the consumer's
      // own onstatechange is NOT clobbered — both fire.
      ctx.setState("suspended");
      ctx.setState("running");

      expect(consumerHandler).toHaveBeenCalled();
      expect(resumed).toHaveBeenCalled();
    });

    it("removes its statechange listener from an injected context on dispose (no dangling handler)", async () => {
      const ctx = new MockAudioContext();
      const player = new Player({
        mode: "webaudio",
        audioContext: ctx as unknown as AudioContext,
      });
      await player.load({ data: createArrayBuffer() });

      expect(ctx.statechangeListenerCount).toBe(1); // player's listener installed

      const resumed = vi.fn();
      player.on("contextresumed", resumed);
      await player.dispose();

      // Listener detached — the still-alive external context has no dangling
      // handler from the dead player.
      expect(ctx.statechangeListenerCount).toBe(0);

      // Further statechange must not reach the disposed player.
      ctx.setState("suspended");
      ctx.setState("running");
      expect(resumed).not.toHaveBeenCalled();
    });
  });

  describe("time-stretch plugin (T-24)", () => {
    it("drives rate via the plugin and keeps the source at 1.0 (no double rate)", async () => {
      const stretch = createMockTimeStretch();
      const player = trackPlayer(
        new Player({ mode: "webaudio", timeStretch: stretch.factory }),
      );
      await player.load({ data: createArrayBuffer() });
      await player.play();

      player.setPlaybackRate(1.5);

      // Source runs at 1.0; the plugin owns tempo — applying rate to both would
      // be audible as chipmunk+slow (double rate).
      expect(getLatestBufferSourceNode().playbackRate.value).toBe(1);
      expect(stretch.setRate).toHaveBeenLastCalledWith(1.5);
    });

    it("reports canPreservePitch === true in webaudio mode with a plugin", async () => {
      const stretch = createMockTimeStretch();
      const player = trackPlayer(
        new Player({ mode: "webaudio", timeStretch: stretch.factory }),
      );
      await player.load({ data: createArrayBuffer() });

      expect(player.canPreservePitch).toBe(true);
    });

    it("derives currentTime from the plugin's input position", async () => {
      const stretch = createMockTimeStretch();
      const player = trackPlayer(
        new Player({ mode: "webaudio", timeStretch: stretch.factory }),
      );
      await player.load({ data: createArrayBuffer() });
      await player.play();

      stretch.setPosition(42);
      expect(player.currentTime).toBe(42); // not the ctx-clock math
    });

    it("flushes the plugin on seek (no stale buffer bleed)", async () => {
      const stretch = createMockTimeStretch();
      const player = trackPlayer(
        new Player({ mode: "webaudio", timeStretch: stretch.factory }),
      );
      await player.load({ data: createArrayBuffer() });
      await player.play();

      player.seek(10);
      expect(stretch.flush).toHaveBeenCalled();
    });

    it("without a plugin the resampling path is untouched (source carries the rate)", async () => {
      const player = trackPlayer(new Player({ mode: "webaudio" }));
      await player.load({ data: createArrayBuffer() });
      await player.play();

      player.setPlaybackRate(1.5);

      expect(getLatestBufferSourceNode().playbackRate.value).toBe(1.5);
      expect(player.canPreservePitch).toBe(false);
    });

    it("ignores the plugin when preservesPitch is false (resamples, no attach)", async () => {
      const stretch = createMockTimeStretch();
      const player = trackPlayer(
        new Player({
          mode: "webaudio",
          timeStretch: stretch.factory,
          preservesPitch: false,
        }),
      );
      await player.load({ data: createArrayBuffer() });
      await player.play();

      player.setPlaybackRate(1.5);

      expect(getLatestBufferSourceNode().playbackRate.value).toBe(1.5);
      expect(stretch.setRate).not.toHaveBeenCalled();
      expect(player.canPreservePitch).toBe(false);
    });
  });
});
