import {
  Input,
  ALL_FORMATS,
  BlobSource,
  UrlSource,
  BufferSource,
  ReadableStreamSource,
  AudioSampleSink,
  InputAudioTrack,
} from "mediabunny";
import {
  PlayerEvent,
  PlayerOptions,
  AudioSource,
  PlayerState,
  Volume,
} from "./types";
import { EQ } from "./EQ";

export class Player {
  private _ctx: AudioContext;
  private _gainNode: GainNode;

  private _eq: EQ;
  private _finalOutput: GainNode;

  private _input?: Input;
  private _track: InputAudioTrack | null = null;
  private _audioBuffer?: AudioBuffer;

  private _currentSource?: AudioBufferSourceNode;
  private _startTime: number = 0;
  private _pausedAt: number = 0;
  private _state: PlayerState = "idle";

  private _events = new Map<PlayerEvent, Set<Function>>();

  // Scratch buffer for enabling iOS to dispose of web audio buffers correctly, as per:
  // http://stackoverflow.com/questions/24119684
  private _scratchBuffer: AudioBuffer | null = null;
  private _loop = false;
  private _playbackRate = 1;

  private _volumeBeforeMute: Volume = Volume(1.0);

  constructor(private _options: PlayerOptions) {
    this._ctx = new (window.AudioContext || (window as any).webkitAudioContext)(
      {
        latencyHint: (this._options.latencyHint ?? "interactive") as any,
      }
    );
    this._scratchBuffer = this._ctx.createBuffer(1, 1, 22050);
    this._gainNode = this._ctx.createGain();
    this._eq = new EQ(this._ctx);
    this._finalOutput = this._ctx.createGain();

    this._gainNode.connect(this._eq.input);
    this._eq.output.connect(this._finalOutput);
    this._finalOutput.connect(this._ctx.destination);
  }

  private updatePosition() {
    if (this._state !== "playing") return;

    const elapsedReal = this._ctx.currentTime - this._startTime;
    const elapsedTrack = elapsedReal * this._playbackRate;

    this._pausedAt += elapsedTrack;

    if (this._loop && this.duration > 0) {
      this._pausedAt = this._pausedAt % this.duration;
    } else if (this.duration > 0) {
      this._pausedAt = Math.min(this._pausedAt, this.duration);
    }

    this._startTime = this._ctx.currentTime;
  }

  get currentTime() {
    if (this._state !== "playing") {
      return this._pausedAt;
    }

    const elapsedReal = this._ctx.currentTime - this._startTime;
    const elapsedTrack = elapsedReal * this._playbackRate;

    let time = this._pausedAt + elapsedTrack;

    if (this._loop && this.duration > 0) {
      time = time % this.duration;
    } else if (this.duration > 0) {
      time = Math.min(time, this.duration);
    }

    return time;
  }

  /**
   *  Get duration of loaded track
   * @returns {number} duration in seconds
   */

  get duration() {
    return this._audioBuffer?.duration ?? 0;
  }

  getEQ(): EQ {
    return this._eq;
  }

  async load(source: AudioSource) {
    await this.stop();
    this._state = "loading";

    let arrayBuffer: ArrayBuffer;
    if (typeof source === "string") {
      try {
        const response = await fetch(source);
        if (!response.ok) throw new Error("Failed to fetch");
        arrayBuffer = await response.arrayBuffer();
      } catch (err) {
        console.error("Fetch failed, fallback to mediabunny", err);
        return this.loadSlowPath(source);
      }
    } else {
      return this.loadSlowPath(source);
    }

    try {
      this._audioBuffer = await this._ctx.decodeAudioData(arrayBuffer);
      this._state = "ready";
      this.emit("loaded");
      this.emit("durationchange");
      return;
    } catch (err) {
      console.error("decodeAudioData failed, fallback", err);
      return this.loadSlowPath(source);
    }
  }

  private async loadSlowPath(source: AudioSource) {
    const inputSource =
      source instanceof File || source instanceof Blob
        ? new BlobSource(source)
        : typeof source === "string"
        ? new UrlSource(source)
        : source instanceof ArrayBuffer || source instanceof Uint8Array
        ? new BufferSource(source)
        : new ReadableStreamSource(source);

    this._input = new Input({ formats: ALL_FORMATS, source: inputSource });
    this._track = await this._input.getPrimaryAudioTrack();
    if (!this._track) throw new Error("No audio track found");

    const sink = new AudioSampleSink(this._track);

    // Info abous channles
    const channelData: Float32Array[][] = [];
    let totalLength = 0;
    let sampleRate = 0;
    let numberOfChannels = 0;

    for await (const sample of sink.samples()) {
      const audioBuffer = sample.toAudioBuffer();

      if (channelData.length === 0) {
        numberOfChannels = audioBuffer.numberOfChannels;
        sampleRate = audioBuffer.sampleRate;
        for (let ch = 0; ch < numberOfChannels; ch++) {
          channelData.push([]);
        }
      }

      // Take raw Float32Array for each channels
      for (let ch = 0; ch < numberOfChannels; ch++) {
        channelData[ch].push(audioBuffer.getChannelData(ch));
      }
      totalLength += audioBuffer.length;
      sample.close();
    }

    if (totalLength === 0) throw new Error("Audio data is empty");

    // 1. Fin buffer
    const merged = this._ctx.createBuffer(
      numberOfChannels,
      totalLength,
      sampleRate
    );

    // 2. Join data set with set()
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const finalChannelArray = new Float32Array(totalLength);
      let offset = 0;

      for (const chunkArray of channelData[ch]) {
        finalChannelArray.set(chunkArray, offset);
        offset += chunkArray.length;
      }

      // 3. Copy fin array in AudioBuffer
      merged.copyToChannel(finalChannelArray, ch);
    }

    this._audioBuffer = merged;
    this._state = "ready";
    this.emit("loaded");
    this.emit("durationchange");
  }

  /**
   *
   * @returns
   */
  async play(): Promise<void> {
    if (!this._audioBuffer) return;

    if (this._state === "playing") {
      this.stopCurrentSource();
    }

    if (this._ctx.state === "suspended") await this._ctx.resume();

    this.stopCurrentSource();

    const source = this._ctx.createBufferSource();
    source.buffer = this._audioBuffer;
    source.playbackRate.value = this._playbackRate;
    source.loop = this._loop;
    source.connect(this._gainNode);

    let offset = this._pausedAt;
    if (this._loop && this.duration > 0) {
      offset = offset % this.duration;
    }

    source.start(0, offset);

    this._startTime = this._ctx.currentTime;
    this._pausedAt = offset;
    this._state = "playing";
    this._currentSource = source;

    if (!this._loop) {
      source.onended = () => {
        if (this._currentSource === source) {
          this._state = "idle";
          this._pausedAt = 0;
          this._currentSource = undefined;
          this.emit("ended");
        }
      };
    }

    this.emit("play");
  }
  /**
   *
   * @returns
   */
  pause() {
    if (this._state !== "playing" || !this._currentSource) return;

    this.updatePosition();

    this.stopCurrentSource();
    this._state = "paused";
    this.emit("pause");
  }

  /**
   * Stop playback and reset position to start
   * @example player.stop();
   * @return void
   */
  stop() {
    this.stopCurrentSource();
    this._pausedAt = 0;
    this._startTime = 0;
    this._state = "idle";
    this.emit("stop");
  }
  /**
   *
   * @param seconds
   * @returns
   */
  seek(seconds: number): this {
    const clamped = Math.max(0, Math.min(seconds, this.duration || 0));

    this._pausedAt = clamped;

    if (this._state === "playing") {
      this.play();
    }

    this.emit("timeupdate", clamped);
    return this;
  }

  /**
   * Stop and disconnect current audio source
   */
  private stopCurrentSource() {
    if (!this._currentSource) return;

    try {
      this._currentSource.stop();
    } catch (e) {}

    this._currentSource.disconnect();
    this._currentSource.onended = null;

    if (this._scratchBuffer) {
      try {
        (this._currentSource as any).buffer = this._scratchBuffer;
      } catch (e) {}
    }

    this._currentSource = undefined;
  }

  /**
   * Set volume
   * @example player.setVolume(0.5);
   * @param {Volume} v number from 0.0 to 1.0
   */
  setVolume(v: Volume): this {
    this._gainNode.gain.value = v;

    if (this._gainNode.gain.value > 0) {
      this._volumeBeforeMute = v;
    }

    return this;
  }

  /**
   *
   * @returns
   */
  getVolume(): Volume {
    return this._gainNode.gain.value as Volume;
  }
  /**
   *
   */
  mute(): void {
    this._volumeBeforeMute =
      this._gainNode.gain.value > 0
        ? (this._gainNode.gain.value as Volume)
        : this._volumeBeforeMute;

    this._gainNode.gain.value = 0;
    this.emit("volumechange");
  }
  /**
   *
   * @returns
   */
  isMuted(): boolean {
    return this._gainNode.gain.value === 0;
  }
  /**
   *
   */
  unmute(): void {
    this._gainNode.gain.value = this._volumeBeforeMute;
    this.emit("volumechange");
  }
  /**
   * Toggle mute state in player
   * @example const isMuted = player.toggleMute();
   * @returns {boolean} true if now muted, false if unmuted
   */
  toggleMute(): boolean {
    if (this.isMuted()) {
      this.unmute();
      return false;
    } else {
      this.mute();
      return true;
    }
  }

  /**
   * Set playback rate
   * @example player.setPlaybackRate(1.5);
   * @param rate
   * @returns `this` for chaining
   */
  setPlaybackRate(rate: number): this {
    if (rate <= 0) throw new RangeError("Playback rate must be positive");

    if (this._state === "playing") {
      this.updatePosition();
      this._startTime = this._ctx.currentTime;
    }

    this._playbackRate = rate;

    if (this._currentSource) {
      this._currentSource.playbackRate.value = rate;
    }
    this.emit("ratechange");
    return this;
  }
  /**
   * @example const rate = player.getPlaybackRate();
   * @returns current playback rate
   */
  getPlaybackRate(): number {
    return this._playbackRate;
  }
  /**
   * Set loop mode
   * @example player.setLoop(true);
   * @param loop - whether to enable or disable looping
   * @returns `this` for chaining
   */
  setLoop(loop: boolean): this {
    this._loop = loop;
    if (this._currentSource) {
      this._currentSource.loop = loop;
    }
    return this;
  }
  /**
   *
   * @returns boolean indicating whether looping is enabled
   */
  getLoop(): boolean {
    return this._loop;
  }

  on(event: PlayerEvent, handler: Function) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event)!.add(handler);
  }

  off(event: PlayerEvent, handler: Function) {
    this._events.get(event)?.delete(handler);
  }

  private emit(event: PlayerEvent, data?: any) {
    this._events.get(event)?.forEach((h) => h(data));
  }
  /**
   * Dispose the player and release all resources
   */
  async dispose() {
    await this.stop();
    await this._ctx.close();
    await this._input?.dispose();
  }
}
