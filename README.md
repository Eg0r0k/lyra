# lyra-audio

A flexible, lightweight audio player library for the browser. Supports both **Web Audio API** and **HTML5 Audio** playback strategies, with optional **HLS streaming** via [hls.js](https://github.com/video-dev/hls.js).

## Features

- 🎵 **Dual playback strategies** — HTML5 Audio for streaming, Web Audio API for precise control
- 📡 **HLS streaming** — optional support via hls.js (peer dependency)
- 🎛️ **Built-in 10-band EQ** — with enable/disable toggle
- 📊 **Audio analysis** — frequency and time-domain data via AnalyserNode
- 🔊 **Volume, mute, playback rate, loop** — full playback control
- 🎚️ **Fade in / out** — smooth volume transitions via Web Audio API
- 📦 **Multiple source types** — URL, Blob, File, ArrayBuffer, Uint8Array, HLS
- 🛡️ **Cancellation support** — safe loading cancellation with CancellationToken
- 🔄 **State machine** — predictable player lifecycle with validated transitions
- 📝 **TypeScript first** — full type definitions with branded types for safety

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Factory Methods](#factory-methods)
- [Loading Sources](#loading-sources)
- [HLS Streaming](#hls-streaming)
- [Playback Control](#playback-control)
- [Volume & Mute](#volume--mute)
- [Fade Effects](#fade-effects)
- [Equalizer](#equalizer)
- [Audio Visualization](#audio-visualization)
- [Cancellation](#cancellation)
- [Events](#events)
- [Error Handling](#error-handling)
- [Player State](#player-state)
- [TypeScript: Branded Types](#typescript-branded-types)
- [API Reference](#api-reference)

---

## Installation

```bash
npm install lyra-audio
# or
pnpm add lyra-audio
```

For HLS support, also install hls.js:

```bash
pnpm add hls.js
```

---

## Quick Start

```typescript
import { Player } from "lyra-audio";

const player = Player.auto();

await player.load("https://example.com/song.mp3");
await player.play();

player.on("timeupdate", ({ currentTime, duration, progress }) => {
  console.log(
    `${currentTime}s / ${duration}s (${(progress * 100).toFixed(1)}%)`,
  );
});

player.on("ended", () => console.log("Track finished"));

await player.dispose();
```

---

## Factory Methods

Three factory methods cover the most common use cases:

```typescript
import { Player } from "lyra-audio";

// Auto-detect the best strategy based on source type
const player = Player.auto();

// Optimized for music — uses "playback" latency hint for better audio quality
const musicPlayer = Player.forMusic();

// Optimized for live streaming — HTML5 only, metadata preload
const streamPlayer = Player.forStreaming();

// Full control via constructor
const customPlayer = new Player({
  mode: "webaudio", // "html5" | "webaudio" | "auto"
  volume: 0.5,
  autoplay: true,
  loop: true,
  latencyHint: "playback",
  muted: false,
  playbackRate: 1,
  preload: "auto", // "none" | "metadata" | "auto"
});
```

### Choosing a strategy

| Strategy   | Best for                           | Notes                                              |
| ---------- | ---------------------------------- | -------------------------------------------------- |
| `html5`    | Streaming, HLS, large files        | Lower memory usage                                 |
| `webaudio` | EQ, visualization, precise control | Decodes full file before playback                  |
| `auto`     | General use                        | Picks `html5` for URLs/HLS, `webaudio` for buffers |

---

## Loading Sources

`load()` accepts several source types. Calling `load()` again automatically cancels any in-progress loading.

```typescript
// Plain URL
await player.load("https://example.com/track.mp3");

// File from <input type="file">
const file = inputElement.files[0];
await player.load(file);

// Blob
await player.load(someBlob);

// ArrayBuffer or Uint8Array — decoded via Web Audio API
await player.load({ data: arrayBuffer });
await player.load({ data: uint8Array });

// URL with custom headers (e.g. authenticated endpoints)
await player.load({
  url: "https://api.example.com/audio/123",
  headers: { Authorization: "Bearer token" },
});

// HLS stream — requires hls.js peer dependency
await player.load({
  url: "https://example.com/stream/playlist.m3u8",
  type: "hls",
});
```

---

## HLS Streaming

Pass the `Hls` constructor when creating the player. lyra-audio treats it as an optional peer dependency and will not import it automatically.

```typescript
import Hls from "hls.js";
import { Player } from "lyra-audio";

const player = new Player({
  Hls,
  hlsConfig: {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
  },
});

await player.load("https://example.com/live/playlist.m3u8");

// Receive available quality levels once the manifest is parsed
player.on("qualitiesavailable", (levels) => {
  console.log("Qualities:", levels);
  // [{ index: 0, bitrate: 500000, label: "500kbps" }, ...]
});

// Switch quality manually (-1 = auto)
const levels = player.getQualityLevels();
player.setQuality(levels[0].index);

// Track active quality
player.on("qualitychange", (level) => {
  console.log("Switched to:", level.label);
});
```

---

## Playback Control

```typescript
await player.play();
player.pause();
player.stop(); // pause + seek to 0
await player.togglePlay();

// Seeking
player.seek(30); // seek to 30 seconds
player.seekPercent(0.5); // seek to 50% of duration

// Playback rate (0.0625–16, clamped automatically)
player.setPlaybackRate(1.5);

player.setLoop(true);

// State and position
console.log(player.state); // current state string
console.log(player.currentTime); // TimeSeconds
console.log(player.duration); // TimeSeconds
console.log(player.isPlaying); // boolean
console.log(player.isReady); // true when ready/playing/paused/buffering
console.log(player.mode); // "html5" | "webaudio"
```

---

## Volume & Mute

```typescript
player.setVolume(0.8); // 0.0–1.0, clamped automatically
player.setMuted(true);
player.toggleMute();

console.log(player.volume); // Volume (0–1)
console.log(player.muted); // boolean

player.on("volumechange", ({ volume, muted }) => {
  updateUI(volume, muted);
});
```

---

## Fade Effects

Fade methods are available after `load()` completes. If called before `load()` or after `dispose()`, they return immediately without doing anything.

```typescript
// Fade to a specific volume over N seconds
await player.fadeTo(0.3, 2);

// Convenience methods
await player.fadeIn(1.5); // fade from 0 to current volume
await player.fadeOut(1.0); // fade to silence

// Fade out then pause/stop (restores volume after)
await player.fadeOutAndPause(1.0);
await player.fadeOutAndStop(1.0);

// Cancel an in-progress fade immediately
player.cancelFade();

console.log(player.isFading); // boolean
```

---

## Equalizer

The EQ is a 10-band parametric equalizer built on `BiquadFilterNode`. It is available via `player.graph` after `load()` completes.

```typescript
await player.load("https://example.com/song.mp3");

const graph = player.graph;
if (!graph) return; // null before load() or after dispose()

// Band indices: 0=32Hz, 1=64Hz, 2=125Hz, 3=250Hz, 4=500Hz,
//               5=1kHz,  6=2kHz,  7=4kHz,  8=8kHz,  9=16kHz

// Set individual band gain in dB
graph.setEQBand(0, 6); // boost 32Hz by 6dB
graph.setEQBand(9, -3); // cut 16kHz by 3dB

// Set all 10 bands at once
graph.setEQBands([6, 4, 2, 0, 0, 0, 0, 2, 4, 6]);

// Read current gain of a band
const bassGain = graph.getEQBand(0);

// Toggle EQ processing (bands retain their values when disabled)
graph.setEQEnabled(false);
graph.setEQEnabled(true);
console.log(graph.eqEnabled); // boolean

// Reset all bands to 0dB
graph.resetEQ();

// Inspect current band config
console.log(graph.bands);
// [{ frequency: 32, gain: 0, Q: 1, type: "lowshelf" }, ...]
```

If you are certain `load()` has already been called, you can use `graphOrThrow` to skip the null check:

```typescript
// Throws a descriptive error if graph is not ready instead of silent null
player.graphOrThrow.setEQBand(0, 6);
```

---

## Audio Visualization

`getFrequencyData()` and `getTimeDomainData()` return a reference to the same internal `Uint8Array` on every call. Copy it with `.slice()` if you need to hold the data across frames.

```typescript
const graph = player.graph;
if (!graph) return;

function draw() {
  if (!player.graph) return;

  // Frequency spectrum — 0–255 per bin
  const freqData = graph.getFrequencyData();

  // Waveform — 0–255, 128 = silence
  const timeData = graph.getTimeDomainData();

  // Snapshot if you need to store it:
  const snapshot = freqData.slice();

  renderVisualizer(freqData, timeData);
  requestAnimationFrame(draw);
}

draw();

// Configure the AnalyserNode directly
graph.analyzer.fftSize = 4096;
graph.analyzer.smoothingTimeConstant = 0.85;
```

You can also pass analyser options when constructing `AudioGraph` directly:

```typescript
import { AudioGraph } from "lyra-audio";

const graph = new AudioGraph(audioContext, {
  analyser: {
    fftSize: 4096,
    smoothingTimeConstant: 0.85,
    minDecibels: -90,
    maxDecibels: -10,
  },
});
```

---

## Cancellation

Calling `load()` again automatically cancels any in-progress load. For manual control use `CancellationToken`:

```typescript
import { CancellationToken, CancellationError } from "lyra-audio";

let token = new CancellationToken();

async function loadTrack(url: string) {
  token.cancel();
  token = new CancellationToken();

  try {
    await token.wrap(player.load(url));
  } catch (err) {
    if (err instanceof CancellationError) {
      console.log("Load cancelled");
    }
  }
}
```

```typescript
const token = new CancellationToken();

token.isCancelled; // false
token.cancel();
token.isCancelled; // true
token.throwIfCancelled(); // throws CancellationError

// Wrap any Promise to make it cancellation-aware
await token.wrap(somePromise);

// Cancel old token and get a fresh one
// Always capture the return value — the old token is cancelled and unusable
token = CancellationToken.replace(token);
```

---

## Events

`player.on()` returns an unsubscribe function.

```typescript
const unsubscribe = player.on("canplay", () => {
  console.log("Ready!");
  unsubscribe();
});

// Wait for a single event (Promise-based)
const { duration } = await player.waitFor("loadedmetadata", {
  timeout: 5000,
  signal: abortController.signal,
});
```

### Event reference

```typescript
// ── Lifecycle ──────────────────────────────────────────────────────────────
player.on("loadstart", () => {});
player.on("loadedmetadata", ({ duration }) => {}); // fired before canplay
player.on("canplay", () => {});
player.on("canplaythrough", () => {}); // enough data to play to end

// ── Playback ───────────────────────────────────────────────────────────────
player.on("play", () => {}); // play() was called
player.on("playing", () => {}); // audio is actually producing output
player.on("pause", () => {});
player.on("ended", () => {});
player.on("stop", () => {});

// ── Time ───────────────────────────────────────────────────────────────────
player.on("timeupdate", ({ currentTime, duration, progress }) => {
  // progress: 0–1
});
player.on("durationchange", (duration) => {});
player.on("seeking", (time) => {});
player.on("seeked", (time) => {});

// ── Buffering ─────────────────────────────────────────────────────────────
player.on("waiting", () => {}); // buffering started, playback stalled
player.on("buffered", () => {}); // buffering ended, playback resumed

// ── State ─────────────────────────────────────────────────────────────────
player.on("statechange", ({ from, to }) => {});

// ── Volume ────────────────────────────────────────────────────────────────
player.on("volumechange", ({ volume, muted }) => {});
player.on("ratechange", (rate) => {});

// ── Quality (HLS only) ────────────────────────────────────────────────────
player.on("qualitiesavailable", (levels) => {}); // QualityLevel[]
player.on("qualitychange", (level) => {}); // QualityLevel

// ── Errors ────────────────────────────────────────────────────────────────
player.on("error", ({ code, message, cause }) => {});

// ── Cleanup ───────────────────────────────────────────────────────────────
player.on("dispose", () => {});
```

---

## Error Handling

All errors include a `PlayerErrorCode`:

```typescript
import { PlayerErrorCode, PlayerError } from "lyra-audio";

player.on("error", ({ code, message, cause }) => {
  switch (code) {
    case PlayerErrorCode.LOAD_ABORTED:
      // Cancelled — usually safe to ignore
      break;
    case PlayerErrorCode.LOAD_NETWORK:
      showToast("Network error. Check your connection.");
      break;
    case PlayerErrorCode.LOAD_DECODE:
      showToast("Could not decode audio file.");
      break;
    case PlayerErrorCode.LOAD_NOT_SUPPORTED:
      showToast("Audio format not supported.");
      break;
    case PlayerErrorCode.PLAYBACK_NOT_ALLOWED:
      // Browser autoplay policy — a user gesture is required
      showPlayButton();
      break;
    case PlayerErrorCode.PLAYBACK_FAILED:
      showToast("Playback failed.");
      break;
    case PlayerErrorCode.HLS_FATAL:
    case PlayerErrorCode.HLS_NETWORK:
    case PlayerErrorCode.HLS_MEDIA:
      showToast("Streaming error.");
      break;
  }
});

// load() and play() also throw — wrap in try/catch if needed
try {
  await player.load(url);
  await player.play();
} catch (err) {
  if (err instanceof PlayerError) {
    console.error(err.code, err.message, err.cause);
  }
}
```

---

## Player State

The player follows a strict state machine. Invalid transitions are ignored with a console warning.

```
idle ──► loading ──► ready ──► playing ──► paused
  ▲         │           │         │           │
  └─────────┴───────────┴────► error ◄────────┘
                                  │
                               disposed
```

| State       | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `idle`      | Initial state, nothing loaded                         |
| `loading`   | `load()` in progress                                  |
| `ready`     | Loaded and ready to play (also after `stop()`)        |
| `playing`   | Audio is playing                                      |
| `paused`    | Paused mid-playback                                   |
| `buffering` | Playing but stalled waiting for data                  |
| `error`     | An error occurred — recover by calling `load()` again |
| `disposed`  | `dispose()` was called — player is unusable           |

```typescript
console.log(player.state);

player.on("statechange", ({ from, to }) => {
  console.log(`${from} → ${to}`);
});
```

---

## TypeScript: Branded Types

lyra-audio uses branded primitive types to prevent accidentally passing a raw number where a typed value is expected:

```typescript
import {
  createVolume,
  createTimeSeconds,
  createPlaybackRate,
  type Volume,
  type TimeSeconds,
  type PlaybackRate,
} from "lyra-audio";

// Constructors validate and clamp values
const vol = createVolume(1.5); // clamped to 1.0
const time = createTimeSeconds(-5); // clamped to 0
const rate = createPlaybackRate(2); // clamped to 0.0625–16

// Plain number is not assignable to a branded type
const v: Volume = 0.5; // TS error
const v: Volume = createVolume(0.5); // ✅

// Event payloads already use branded types
player.on("timeupdate", ({ currentTime, duration }) => {
  const mid = createTimeSeconds(duration / 2);
  player.seek(mid);
});
```

---

## API Reference

### `Player`

| Method / Property               | Type                 | Description                                |
| ------------------------------- | -------------------- | ------------------------------------------ |
| `Player.auto(options?)`         | static               | Factory: auto strategy                     |
| `Player.forMusic(options?)`     | static               | Factory: latencyHint "playback"            |
| `Player.forStreaming(options?)` | static               | Factory: HTML5, metadata preload           |
| `load(source)`                  | `Promise<void>`      | Load a source. Cancels any previous load.  |
| `play()`                        | `Promise<void>`      | Start or resume playback                   |
| `pause()`                       | `void`               | Pause playback                             |
| `stop()`                        | `void`               | Pause and seek to 0                        |
| `togglePlay()`                  | `Promise<void>`      | Toggle play/pause                          |
| `seek(seconds)`                 | `void`               | Seek to absolute position                  |
| `seekPercent(0–1)`              | `void`               | Seek to relative position                  |
| `setVolume(0–1)`                | `void`               | Set volume (clamped automatically)         |
| `setMuted(bool)`                | `void`               | Set mute state                             |
| `toggleMute()`                  | `void`               | Toggle mute                                |
| `setPlaybackRate(rate)`         | `void`               | Set speed (clamped to 0.0625–16)           |
| `setLoop(bool)`                 | `void`               | Enable/disable loop                        |
| `fadeTo(vol, sec)`              | `Promise<void>`      | Fade to volume over duration               |
| `fadeIn(sec)`                   | `Promise<void>`      | Fade from 0 to current volume              |
| `fadeOut(sec)`                  | `Promise<void>`      | Fade to silence                            |
| `fadeOutAndPause(sec)`          | `Promise<void>`      | Fade out then pause                        |
| `fadeOutAndStop(sec)`           | `Promise<void>`      | Fade out then stop                         |
| `cancelFade()`                  | `void`               | Cancel in-progress fade                    |
| `getQualityLevels()`            | `QualityLevel[]`     | HLS quality levels                         |
| `setQuality(index)`             | `void`               | Select HLS quality level                   |
| `getCurrentQuality()`           | `number`             | Current HLS quality index (-1 = auto)      |
| `dispose()`                     | `Promise<void>`      | Release all resources                      |
| `state`                         | `PlayerState`        | Current state                              |
| `currentTime`                   | `TimeSeconds`        | Current playback position                  |
| `duration`                      | `TimeSeconds`        | Total duration                             |
| `volume`                        | `Volume`             | Current volume (0–1)                       |
| `muted`                         | `boolean`            | Mute state                                 |
| `playbackRate`                  | `PlaybackRate`       | Current playback rate                      |
| `loop`                          | `boolean`            | Loop state                                 |
| `isPlaying`                     | `boolean`            | True if currently playing                  |
| `isReady`                       | `boolean`            | True if ready/playing/paused/buffering     |
| `isFading`                      | `boolean`            | True if a fade is in progress              |
| `mode`                          | `PlaybackMode`       | Active strategy: `"html5"` \| `"webaudio"` |
| `graph`                         | `AudioGraph \| null` | Audio graph — available after `load()`     |
| `graphOrThrow`                  | `AudioGraph`         | Same, but throws if not ready              |
| `audioContext`                  | `AudioContext`       | Underlying AudioContext (lazy-created)     |

### `AudioGraph`

| Method / Property         | Type            | Description                                        |
| ------------------------- | --------------- | -------------------------------------------------- |
| `setEQBand(index, dB)`    | `void`          | Set single band gain in dB                         |
| `setEQBands(gains[])`     | `void`          | Set all 10 bands at once                           |
| `getEQBand(index)`        | `number`        | Get current gain for a band                        |
| `resetEQ()`               | `void`          | Reset all bands to 0dB                             |
| `setEQEnabled(bool)`      | `void`          | Toggle EQ processing                               |
| `setVolume(0–1)`          | `void`          | Set output volume                                  |
| `fadeTo(vol, sec, from?)` | `Promise<void>` | Fade output volume                                 |
| `cancelFade()`            | `void`          | Cancel in-progress fade                            |
| `getFrequencyData()`      | `Uint8Array`    | Frequency spectrum (live buffer — copy if storing) |
| `getTimeDomainData()`     | `Uint8Array`    | Waveform data (live buffer — copy if storing)      |
| `eqEnabled`               | `boolean`       | Whether EQ is active                               |
| `bands`                   | `EQBand[]`      | Current band configuration                         |
| `isFading`                | `boolean`       | Whether a fade is running                          |
| `input`                   | `AudioNode`     | Graph input node                                   |
| `output`                  | `AudioNode`     | Graph output node                                  |
| `analyzer`                | `AnalyserNode`  | Direct access for custom configuration             |

### `CancellationToken`

| Method / Property                | Type          | Description                                            |
| -------------------------------- | ------------- | ------------------------------------------------------ |
| `cancel()`                       | `void`        | Cancel the token                                       |
| `isCancelled`                    | `boolean`     | Whether the token is cancelled                         |
| `throwIfCancelled()`             | `void`        | Throws `CancellationError` if cancelled                |
| `wrap(promise)`                  | `Promise<T>`  | Rejects with `CancellationError` if token is cancelled |
| `signal`                         | `AbortSignal` | Underlying AbortSignal                                 |
| `CancellationToken.replace(old)` | static        | Cancels old token, returns a new one                   |
