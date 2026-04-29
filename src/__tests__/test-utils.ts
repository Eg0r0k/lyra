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
  public readonly start = vi.fn((_when?: number, _offset?: number) => undefined);
  public readonly stop = vi.fn(() => {
    this.onended?.();
  });
}

export class MockAudioContext {
  public static instances: MockAudioContext[] = [];
  public static decodeError: unknown = null;
  public static decodedDuration = 120;

  public state: AudioContextState = "running";
  public currentTime = 0;
  public readonly destination = new MockAudioNode() as unknown as AudioDestinationNode;
  public readonly createdGains: MockGainNode[] = [];
  public readonly createdBufferSources: MockBufferSourceNode[] = [];

  constructor(_options?: AudioContextOptions) {
    MockAudioContext.instances.push(this);
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

  public createMediaElementSource(_audio: HTMLMediaElement): MediaElementAudioSourceNode {
    return new MockMediaElementSourceNode() as unknown as MediaElementAudioSourceNode;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const node = new MockBufferSourceNode();
    this.createdBufferSources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  public async decodeAudioData(_arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    if (MockAudioContext.decodeError) {
      throw MockAudioContext.decodeError;
    }

    return {
      duration: MockAudioContext.decodedDuration,
    } as AudioBuffer;
  }

  public async resume(): Promise<void> {
    this.state = "running";
  }

  public async close(): Promise<void> {
    this.state = "closed";
  }

  public static reset(): void {
    MockAudioContext.instances = [];
    MockAudioContext.decodeError = null;
    MockAudioContext.decodedDuration = 120;
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

function createTimeRanges(): TimeRanges {
  return {
    length: 0,
    start: () => 0,
    end: () => 0,
  };
}

type AudioMockState = {
  instances: MockAudioElement[];
  defaultDuration: number;
  autoLoadCanPlay: boolean;
  loadDelayMs: number;
  nextLoadError: MockMediaError | null;
  nextPlayError: Error | null;
};

const audioMockState: AudioMockState = {
  instances: [],
  defaultDuration: 180,
  autoLoadCanPlay: true,
  loadDelayMs: 0,
  nextLoadError: null,
  nextPlayError: null,
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

  constructor() {
    super();
    this.duration = audioMockState.defaultDuration;
    audioMockState.instances.push(this);
  }

  public load(): void {
    const completeLoad = () => {
      if (audioMockState.nextLoadError) {
        this.error = audioMockState.nextLoadError;
        audioMockState.nextLoadError = null;
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
  objectUrlCounter = 0;
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

export function mockFetchSuccess(arrayBuffer: ArrayBuffer = createArrayBuffer()): void {
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
    fetchMock.mockImplementationOnce(((_input: RequestInfo | URL, init?: RequestInit) => {
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
