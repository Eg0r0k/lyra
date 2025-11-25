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
  PlayerEvents,
} from "./types";
import { EQ } from "./EQ";
import { EventEmitter } from "./EventEmitter";
import { PlaybackTimeController } from "./PlaybackTimeController";
import { AudioGraph } from "./AudioGraph";
import {  LogLevel, playerLogger } from "./utils/logger";

export class Player {
  private _ctx: AudioContext;

private _audioGraph: AudioGraph;
  private _input?: Input;
  private _track: InputAudioTrack | null = null;
  private _audioBuffer?: AudioBuffer;

  private _currentSource?: AudioBufferSourceNode;
  private _state: PlayerState = "idle";

  private _events = new EventEmitter<PlayerEvents>();


  private _abortController?: AbortController

  private _timeController: PlaybackTimeController;

  // Scratch buffer for enabling iOS to dispose of web audio buffers correctly, as per:
  // http://stackoverflow.com/questions/24119684
  private _scratchBuffer: AudioBuffer | null = null;

  private _volumeBeforeMute: Volume = Volume(1.0);

  constructor(private _options: PlayerOptions) {
    this._ctx = new (window.AudioContext || (window as any).webkitAudioContext)(
      {
        latencyHint: (this._options.latencyHint ?? "interactive") as any,
      }
    );
    playerLogger.info("Player initialized.", { latencyHint: this._options.latencyHint });
    this._scratchBuffer = this._ctx.createBuffer(1, 1, 22050);
    this._timeController = new PlaybackTimeController(() => this.duration);
   this._audioGraph = new AudioGraph(this._ctx);
  }
  /**
   * Get the current playback position.
   * @returns {number} Current time in seconds.
   */
  get currentTime() {
    return this._timeController.compute(this._ctx.currentTime);
  }

  /**
   * Get duration of the loaded track.
   * @returns {number} Duration in seconds. Returns 0 if no track is loaded.
   */
  get duration() {
    return this._audioBuffer?.duration ?? 0;
  }
  /**
   * Retrieves the Equalizer (EQ) module instance for direct control of frequency bands.
   * @returns {EQ} The Equalizer instance.
   */
  getEQ(): EQ {
    return this._audioGraph.eq; 
  }
  /**
   * Enables or disables the Equalizer module within the audio graph.
   * @param {boolean} bypassEnabled - `true` to bypass (disable) the EQ, `false` to enable it.
   * @returns {this} The player instance for chaining.
   */
  setEQBypass(bypassEnabled: boolean): this {
    this._audioGraph.bypassEQ(bypassEnabled);
    return this;
  }
  /**
   * Loads an audio track from a given source.
   * Supports URLs, Files/Blobs, ArrayBuffers, and ReadableStreams.
   * Attempts fast native decoding first, falling back to mediabunny if needed.
   * @async
   * @param {AudioSource} source - The source of the audio data.
   * @returns {Promise<void>}
   * @throws {Error} If no audio track is found or data is empty.
   */
  async load(source: AudioSource) {
    await this.stop();
    this._state = "loading";
    //TODO: Add abortController and mb create different class to control src loading 
    this._abortController = new AbortController()
    const signal = this._abortController.signal

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
  /**
   * Internal method for loading audio using the mediabunny library (slow path).
   * Decodes complex formats, streams, and chunks audio data.
   * @private
   * @async
   * @param {AudioSource} source
   * @returns {Promise<void>}
   */
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
   * Starts or resumes audio playback from the current position.
   * Automatically resumes the AudioContext if suspended.
   * @async
   * @returns {Promise<void>}
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
    
    source.playbackRate.value = this._timeController.getRate(); 
    source.loop = this._timeController.getLoop();
    
    source.connect(this._audioGraph.input);
    
    let offset = this._timeController.compute(this._ctx.currentTime);
    
    if (this._timeController.getLoop() && this.duration > 0) {
        offset = offset % this.duration;
    }

    source.start(0, offset);

    this._timeController.onStart(offset);
    this._timeController.setStartCtxTime(this._ctx.currentTime);
    
    this._state = "playing";
    this._currentSource = source;
    playerLogger.info(`Playback started at offset ${offset.toFixed(2)}s.`);
    if (!this._timeController.getLoop()) { 
      source.onended = () => {
        if (this._currentSource === source) {
          this._state = "idle";
          
          this._timeController.seek(0);
          
          this._currentSource = undefined;
          this.emit("ended");
        }
      };
    }

    this.emit("play");
  }
  /**
   * Pauses audio playback, retaining the current position.
   * @returns {void}
   */
  pause() {
    if (this._state !== "playing" || !this._currentSource) return;

    this._timeController.pauseAt(this._ctx.currentTime);
    
    this.stopCurrentSource();
    this._state = "paused";
    this.emit("pause");
  }

  /**
   * Stops playback and resets the position to 0 seconds.
   * @returns {void}
   */
  stop() {
    this.stopCurrentSource();
    
    this._timeController.onStart(0); 
    
    this._state = "idle";
    this.emit("stop");
  }
  /**
   * Seeks to a specific time offset in the track.
   * If playing, playback restarts at the new offset.
   * @param {number} seconds - The time offset in seconds.
   * @returns {this} The player instance for chaining.
   */
  seek(seconds: number): this {
    this._timeController.seek(seconds);
    const clamped = this._timeController.compute(this._ctx.currentTime);
    if (this._state === "playing") {
      this.play();
    }
    
    this.emit("timeupdate", clamped);
    return this;
  }

  /**
   * Stops and disconnects the current AudioBufferSourceNode.
   * Includes scratch buffer logic for iOS Web Audio cleanup.
   * @private
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
   * Sets the playback volume.
   * @param {Volume} v - Volume level (0.0 to 1.0).
   * @returns {this} The player instance for chaining.
   */
  setVolume(v: Volume): this {
    this._audioGraph.setVoulme(v);
    
    if (this._audioGraph.getVolume() > 0) {
        this._volumeBeforeMute = v;
    }

    this.emit("volumechange", this.getVolume()); 
    return this;
  }

  /**
   * Get the current volume level.
   * @returns {Volume} Current volume level (0.0 to 1.0).
   */
  getVolume(): Volume {
    return this._audioGraph.getVolume() as Volume;
  }
  /**
   * Mutes the player, setting volume to 0 but retaining the previous volume level.
   * @returns {void}
   */
  mute(): void {
    const currentVolume = this._audioGraph.getVolume() as Volume;

    this._volumeBeforeMute =
        currentVolume > 0
            ? currentVolume
            : this._volumeBeforeMute;

    this._audioGraph.setVoulme(0); 
    this.emit("volumechange", this.getVolume() );
  }
  /**
   * Checks if the player is currently muted.
   * @returns {boolean} `true` if muted, `false` otherwise.
   */
  isMuted(): boolean {
    return this._audioGraph.getVolume() === 0;
  }
  /**
   * Restores the volume to the level before it was muted.
   * @returns {void}
   */
  unmute(): void {
    this._audioGraph.setVoulme(this._volumeBeforeMute); 
    this.emit("volumechange", this.getVolume());
  }
  /**
   * Toggles the mute state.
   * @returns {boolean} `true` if now muted, `false` if unmuted.
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
   * Sets the playback rate (speed).
   * @param {number} rate - The playback rate (e.g., 1.0 is normal, 2.0 is double speed). Must be positive.
   * @returns {this} The player instance for chaining.
   * @throws {RangeError} If the rate is non-positive.
   */
  setPlaybackRate(rate: number): this {
if (rate <= 0) throw new RangeError("Playback rate must be positive");
if (this._state === "playing") {
this._timeController.setRatePlaying(this._ctx.currentTime, rate);
} else {
 this._timeController.setRate(rate);
}

if (this._currentSource) {
this._currentSource.playbackRate.value = rate;
}
this.emit("ratechange", rate);
return this;
  }
  /**
   * Gets the current playback rate.
   * @returns {number} The current playback rate.
   */
  getPlaybackRate(): number {
    return this._timeController.getRate();
  }
  /**
   * Enables or disables track looping.
   * @param {boolean} loop - `true` to enable looping, `false` to disable.
   * @returns {this} The player instance for chaining.
   */
  setLoop(loop: boolean): this {
    this._timeController.setLoop(loop);
    
    if (this._currentSource) {
      this._currentSource.loop = loop;
    }
    return this;
  }
  /**
   * Gets the current loop state.
   * @returns {boolean} `true` if looping is enabled, `false` otherwise.
   */
  getLoop(): boolean {
    return this._timeController.getLoop();
  }

  on<K extends PlayerEvent>(event: K, handler: (...data: PlayerEvents[K]) => void) {
  this._events.on(event, handler as any);
  }

  once<K extends PlayerEvent>(event: K, handler: (...data: PlayerEvents[K]) => void) {
  this._events.once(event, handler as any);
  }

  off<K extends PlayerEvent>(event: K, handler?: (...data: PlayerEvents[K]) => void) {
  this._events.off(event, handler as any);
  }

  private emit<K extends PlayerEvent>(event: K, ...data: PlayerEvents[K]) {
    this._events.emit(event, ...(data as any)); 
  }



  public setLogLevel(level: LogLevel): this {
        playerLogger.setLevel(level);
        return this;
    }
  /**
   * Disposes of the player, stopping playback, cleaning up the audio graph,
   * closing the AudioContext, and releasing resources used by mediabunny.
   * @async
   * @returns {Promise<void>}
   */
  async dispose() {
    await this.stop();
    
    this._audioGraph.dispose(); 

    await this._ctx.close();
    await this._input?.dispose();
    playerLogger.info("Player disposed and all resources released.");
  }
}
