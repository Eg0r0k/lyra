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
import {
  MockAudioContext,
  MockAudioElement,
  MockMediaError,
  createArrayBuffer,
  createDeferred,
  fetchMock,
  getLatestAudioElement,
  mockFetchSuccess,
  setAudioAutoLoadCanPlay,
  setMockAudioDuration,
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

      player.setVolume(1.5);
      expect(player.volume).toBe(1);
      expect(getLatestAudioElement().volume).toBe(1);

      player.setVolume(-0.2);
      expect(player.volume).toBe(0);
      expect(getLatestAudioElement().volume).toBe(0);

      player.setMuted(true);
      expect(player.muted).toBe(true);
      expect(getLatestAudioElement().muted).toBe(true);

      player.toggleMute();
      expect(player.muted).toBe(false);
      expect(getLatestAudioElement().muted).toBe(false);

      player.setPlaybackRate(32);
      expect(player.playbackRate).toBe(16);

      player.setPlaybackRate(0);
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
});
