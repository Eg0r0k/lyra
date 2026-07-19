import { vi } from "vitest";

type MockParam = {
  value: number;
  setValueAtTime: (value: number, time: number) => void;
  setTargetAtTime: (value: number, time: number, timeConstant: number) => void;
  linearRampToValueAtTime: (value: number, time: number) => void;
  exponentialRampToValueAtTime: (value: number, time: number) => void;
  cancelScheduledValues: (time: number) => void;
};

function createAudioParam(initialValue: number): MockParam {
  const param: MockParam = {
    value: initialValue,
    setValueAtTime: vi.fn((value: number) => {
      param.value = value;
    }),
    setTargetAtTime: vi.fn((value: number) => {
      param.value = value;
    }),
    linearRampToValueAtTime: vi.fn((value: number) => {
      param.value = value;
    }),
    exponentialRampToValueAtTime: vi.fn((value: number) => {
      param.value = value;
    }),
    cancelScheduledValues: vi.fn(() => undefined),
  };

  return param;
}

class MockAudioNode {
  public readonly connect = vi.fn((_node?: unknown) => undefined);
  public readonly disconnect = vi.fn(() => undefined);
}

class MockGainNode extends MockAudioNode {
  public readonly gain: MockParam = createAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode {
  public type: BiquadFilterType = "peaking";
  public readonly frequency: MockParam = createAudioParam(0);
  public readonly gain: MockParam = createAudioParam(0);
  public readonly Q: MockParam = createAudioParam(1);
}

class MockAnalyserNode extends MockAudioNode {
  public fftSize = 2048;
  public smoothingTimeConstant = 0.8;
  public minDecibels = -100;
  public maxDecibels = -30;

  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  public getByteFrequencyData(array: Uint8Array): void {
    array.fill(64);
  }

  public getByteTimeDomainData(array: Uint8Array): void {
    array.fill(128);
  }
}

class MockMediaElementSourceNode extends MockAudioNode {}

class MockBufferSourceNode extends MockAudioNode {
  public buffer: AudioBuffer | null = null;
  public loop = false;
  public onended: (() => void) | null = null;
  public readonly playbackRate: MockParam = createAudioParam(1);
  public readonly start = vi.fn(
    (_when?: number, _offset?: number) => undefined,
  );
  public readonly stop = vi.fn(() => {
    this.onended?.();
  });
}

export class MockAudioContext extends EventTarget {
  public static instances: MockAudioContext[] = [];
  public static decodeError: unknown = null;
  public static decodedDuration = 120;
  /**
   * When set, the next decodeAudioData() call returns this promise instead of
   * resolving immediately (one-shot). Lets tests hold a decode open across a
   * superseding load to exercise stale-rejection handling.
   */
  public static nextDecodeDeferred: Promise<AudioBuffer> | null = null;
  /**
   * When set, resume() rejects with this value and leaves the state unchanged.
   * Exercises the auto-resume rejection path (F-17).
   */
  public static resumeError: unknown = null;
  /**
   * When true, resume() resolves but does NOT flip the state to "running",
   * simulating a context that stays suspended forever (F-16).
   */
  public static resumeKeepsState = false;

  public state: AudioContextState = "running";
  public currentTime = 0;
  public onstatechange: ((this: AudioContext, ev: Event) => unknown) | null =
    null;
  public readonly destination =
    new MockAudioNode() as unknown as AudioDestinationNode;
  public readonly createdGains: MockGainNode[] = [];
  public readonly createdBufferSources: MockBufferSourceNode[] = [];
  private readonly _statechangeListeners = new Set<EventListenerOrEventListenerObject>();

  constructor(_options?: AudioContextOptions) {
    super();
    MockAudioContext.instances.push(this);
  }

  /** Number of "statechange" listeners registered via addEventListener. */
  public get statechangeListenerCount(): number {
    return this._statechangeListeners.size;
  }

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "statechange" && listener) {
      this._statechangeListeners.add(listener);
    }
    super.addEventListener(type, listener, options);
  }

  public removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "statechange" && listener) {
      this._statechangeListeners.delete(listener);
    }
    super.removeEventListener(type, listener, options);
  }

  public setState(newState: AudioContextState): void {
    this.state = newState;
    const event = new Event("statechange");
    this.onstatechange?.call(this as unknown as AudioContext, event);
    this.dispatchEvent(event);
  }

  public createGain(): GainNode {
    const node = new MockGainNode();
    this.createdGains.push(node);
    return node as unknown as GainNode;
  }

  public createAnalyser(): AnalyserNode {
    return new MockAnalyserNode() as unknown as AnalyserNode;
  }

  public createBiquadFilter(): BiquadFilterNode {
    return new MockBiquadFilterNode() as unknown as BiquadFilterNode;
  }

  public createMediaElementSource(
    _audio: HTMLMediaElement,
  ): MediaElementAudioSourceNode {
    return new MockMediaElementSourceNode() as unknown as MediaElementAudioSourceNode;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const node = new MockBufferSourceNode();
    this.createdBufferSources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  public createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer {
    return {
      numberOfChannels,
      length,
      sampleRate,
      duration: length / sampleRate,
    } as unknown as AudioBuffer;
  }

  public async decodeAudioData(
    _arrayBuffer: ArrayBuffer,
  ): Promise<AudioBuffer> {
    if (MockAudioContext.decodeError) {
      throw MockAudioContext.decodeError;
    }

    const deferred = MockAudioContext.nextDecodeDeferred;
    if (deferred) {
      MockAudioContext.nextDecodeDeferred = null;
      return deferred;
    }

    return {
      duration: MockAudioContext.decodedDuration,
    } as AudioBuffer;
  }

  public async resume(): Promise<void> {
    if (MockAudioContext.resumeError) {
      throw MockAudioContext.resumeError;
    }
    if (MockAudioContext.resumeKeepsState) {
      return;
    }
    this.setState("running");
  }

  public async close(): Promise<void> {
    this.state = "closed";
  }

  public static reset(): void {
    MockAudioContext.instances = [];
    MockAudioContext.decodeError = null;
    MockAudioContext.decodedDuration = 120;
    MockAudioContext.nextDecodeDeferred = null;
    MockAudioContext.resumeError = null;
    MockAudioContext.resumeKeepsState = false;
  }
}

export class MockMediaError extends Error {
  public static readonly MEDIA_ERR_ABORTED = 1;
  public static readonly MEDIA_ERR_NETWORK = 2;
  public static readonly MEDIA_ERR_DECODE = 3;
  public static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

  constructor(
    public readonly code: number,
    message = "Mock media error",
  ) {
    super(message);
  }
}

function createTimeRanges(
  ranges: Array<{ start: number; end: number }> = [],
): TimeRanges {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i].start,
    end: (i: number) => ranges[i].end,
  };
}

type AudioMockState = {
  instances: MockAudioElement[];
  defaultDuration: number;
  autoLoadCanPlay: boolean;
  loadDelayMs: number;
  nextLoadError: MockMediaError | null;
  nextPlayError: Error | null;
  nextPlayDeferred: Promise<void> | null;
};

const audioMockState: AudioMockState = {
  instances: [],
  defaultDuration: 180,
  autoLoadCanPlay: true,
  loadDelayMs: 0,
  nextLoadError: null,
  nextPlayError: null,
  nextPlayDeferred: null,
};

export class MockAudioElement extends EventTarget {
  public src = "";
  public crossOrigin: string | null = null;
  public preload: "none" | "metadata" | "auto" | "" = "auto";
  public currentTime = 0;
  public duration = audioMockState.defaultDuration;
  public paused = true;
  public ended = false;
  public readyState = 0;
  public muted = false;
  public volume = 1;
  public playbackRate = 1;
  public loop = false;
  public error: MockMediaError | null = null;
  public readonly buffered: TimeRanges = createTimeRanges();
  /** Seekable window; live streams populate it (see setSeekableRange). */
  public seekable: TimeRanges = createTimeRanges();
  /** True while play() is parked on a test-supplied deferred (see setNextAudioPlayDeferred). */
  public playPending = false;
  private readonly attributes = new Map<string, string>();

  constructor() {
    super();
    this.duration = audioMockState.defaultDuration;
    audioMockState.instances.push(this);
  }

  /** Test helper: set the seekable window (used to exercise live seek clamping). */
  public setSeekableRange(start: number, end: number): void {
    this.seekable = createTimeRanges([{ start, end }]);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public load(): void {
    const completeLoad = () => {
      if (audioMockState.nextLoadError) {
        this.error = audioMockState.nextLoadError;
        audioMockState.nextLoadError = null;
        this.dispatchEvent(new Event("error"));
        return;
      }

      if (!this.src) {
        // Browsers reject an empty media source. HTML5Strategy.dispose() sets
        // src="" and calls load(), which fires this error asynchronously —
        // the canonical F-05 stale-rejection trigger.
        this.error = new MockMediaError(
          MockMediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
          "Empty media source",
        );
        this.readyState = 0;
        this.dispatchEvent(new Event("error"));
        return;
      }

      if (!audioMockState.autoLoadCanPlay) {
        return;
      }

      this.readyState = 4;
      this.duration = audioMockState.defaultDuration;
      this.dispatchEvent(new Event("durationchange"));
      this.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("canplay"));
      this.dispatchEvent(new Event("canplaythrough"));
    };

    if (audioMockState.loadDelayMs > 0) {
      setTimeout(completeLoad, audioMockState.loadDelayMs);
      return;
    }

    queueMicrotask(completeLoad);
  }

  public async play(): Promise<void> {
    if (audioMockState.nextPlayError) {
      const error = audioMockState.nextPlayError;
      audioMockState.nextPlayError = null;
      throw error;
    }

    const deferred = audioMockState.nextPlayDeferred;
    if (deferred) {
      audioMockState.nextPlayDeferred = null;
      this.playPending = true;
      try {
        await deferred;
      } finally {
        this.playPending = false;
      }
    }

    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
  }

  public pause(): void {
    const shouldEmit = !this.paused && !this.ended;
    this.paused = true;
    if (shouldEmit) {
      this.dispatchEvent(new Event("pause"));
    }
  }

  public finish(): void {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }

  public emitTimeUpdate(time: number): void {
    this.currentTime = time;
    this.dispatchEvent(new Event("timeupdate"));
  }

  public emitWaiting(): void {
    this.dispatchEvent(new Event("waiting"));
  }

  public emitBuffered(): void {
    this.dispatchEvent(new Event("playing"));
  }
}

export const fetchMock = vi.fn<typeof fetch>();

let objectUrlCounter = 0;
let nativeHlsSupported = false;

export function installBrowserMocks(): void {
  vi.stubGlobal("Audio", MockAudioElement);
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("webkitAudioContext", MockAudioContext);
  vi.stubGlobal("MediaError", MockMediaError);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    return setTimeout(() => cb(Date.now()), 16) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    clearTimeout(id);
  });

  const urlObject = globalThis.URL;
  vi.spyOn(urlObject, "createObjectURL").mockImplementation(() => {
    objectUrlCounter += 1;
    return `blob:mock-${objectUrlCounter}`;
  });
  vi.spyOn(urlObject, "revokeObjectURL").mockImplementation(() => undefined);

  // NativeHlsHandler probes `document.createElement("audio").canPlayType(...)`.
  // jsdom returns "" (no native HLS); drive it via nativeHlsSupported so tests
  // can simulate Safari/iOS. Auto-resets each test in resetBrowserMocks().
  vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockImplementation(
    (type: string): CanPlayTypeResult =>
      type === "application/vnd.apple.mpegurl" && nativeHlsSupported
        ? "maybe"
        : "",
  );
}

export function resetBrowserMocks(): void {
  fetchMock.mockReset();
  MockAudioContext.reset();
  audioMockState.instances = [];
  audioMockState.defaultDuration = 180;
  audioMockState.autoLoadCanPlay = true;
  audioMockState.loadDelayMs = 0;
  audioMockState.nextLoadError = null;
  audioMockState.nextPlayError = null;
  audioMockState.nextPlayDeferred = null;
  objectUrlCounter = 0;
  nativeHlsSupported = false;
}

export function setAudioAutoLoadCanPlay(value: boolean): void {
  audioMockState.autoLoadCanPlay = value;
}

export function setAudioLoadDelay(ms: number): void {
  audioMockState.loadDelayMs = ms;
}

export function setNextAudioLoadError(error: MockMediaError): void {
  audioMockState.nextLoadError = error;
}

export function setNextAudioPlayError(error: Error): void {
  audioMockState.nextPlayError = error;
}

export function setNextAudioPlayDeferred(promise: Promise<void>): void {
  audioMockState.nextPlayDeferred = promise;
}

export function setNativeHlsSupport(supported: boolean): void {
  nativeHlsSupported = supported;
}

export function setMockAudioDuration(duration: number): void {
  audioMockState.defaultDuration = duration;
}

export function getLatestAudioElement(): MockAudioElement {
  const audio = audioMockState.instances[audioMockState.instances.length - 1];
  if (!audio) {
    throw new Error("No mock audio element was created");
  }
  return audio;
}

export function getLatestAudioContext(): MockAudioContext {
  const ctx = MockAudioContext.instances[MockAudioContext.instances.length - 1];
  if (!ctx) {
    throw new Error("No mock audio context was created");
  }
  return ctx;
}

export function getLatestGainNode(): GainNode {
  const ctx = getLatestAudioContext();
  const node = ctx.createdGains[ctx.createdGains.length - 1];
  if (!node) {
    throw new Error("No mock gain node was created");
  }
  return node as unknown as GainNode;
}

/**
 * The AudioGraph fade gain — the second-to-last gain node created
 * (chain: … → fadeGain → volumeGain). `getLatestGainNode()` returns the volume
 * gain; this returns the fade gain that fadeTo/cancelFade drive.
 */
export function getFadeGainNode(): GainNode {
  const ctx = getLatestAudioContext();
  const node = ctx.createdGains[ctx.createdGains.length - 2];
  if (!node) {
    throw new Error("No mock fade gain node was created");
  }
  return node as unknown as GainNode;
}

export function getLatestBufferSourceNode(): AudioBufferSourceNode {
  const ctx = getLatestAudioContext();
  const node = ctx.createdBufferSources[ctx.createdBufferSources.length - 1];
  if (!node) {
    throw new Error("No mock buffer source node was created");
  }
  return node as unknown as AudioBufferSourceNode;
}

export function createArrayBuffer(length = 16): ArrayBuffer {
  return new Uint8Array(length).buffer;
}

export function mockFetchSuccess(
  arrayBuffer: ArrayBuffer = createArrayBuffer(),
): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => arrayBuffer,
  } as Response);
}

export function createAbortableFetchPromise(): {
  promise: Promise<Response>;
  abortSpy: ReturnType<typeof vi.fn>;
} {
  const abortSpy = vi.fn();

  const promise = new Promise<Response>((_resolve, reject) => {
    fetchMock.mockImplementationOnce(((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      init?.signal?.addEventListener("abort", () => {
        abortSpy();
        reject(new DOMException("Aborted", "AbortError"));
      });

      return promise;
    }) as typeof fetch);
  });

  return { promise, abortSpy };
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
