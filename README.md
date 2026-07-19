# lyra-audio

[![npm](https://img.shields.io/npm/v/lyra-audio.svg)](https://www.npmjs.com/package/lyra-audio)
[![bundle size](https://img.shields.io/badge/gzip-~20%20KB-brightgreen.svg)](#bundle-size--tree-shaking)
[![license](https://img.shields.io/npm/l/lyra-audio.svg)](./LICENSE)

A browser audio player that plays URLs, `File`/`Blob`, `ArrayBuffer`/`Uint8Array`, and HLS streams through one `Player` facade. It picks an HTML5 `<audio>` pipeline or a Web Audio pipeline per source, and routes HTML5 through the Web Audio graph by default so EQ, analyser, fades, and loudness normalization work everywhere.

Browser-only: it relies on `AudioContext`, `HTMLMediaElement`, `File`/`Blob`, `fetch`, `URL.createObjectURL`, and `AbortController`.

## Table of Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Browser support & limitations](#browser-support--limitations)
- [Choosing a strategy](#choosing-a-strategy)
- [Loading sources](#loading-sources)
- [HLS streaming](#hls-streaming)
- [Playback control](#playback-control)
- [Rate & pitch](#rate--pitch)
- [Volume & mute](#volume--mute)
- [Fades](#fades)
- [Equalizer](#equalizer)
- [Visualization](#visualization)
- [Loudness normalization](#loudness-normalization)
- [AudioContext management](#audiocontext-management)
- [Cancellation](#cancellation)
- [Events](#events)
- [Error handling](#error-handling)
- [Player state](#player-state)
- [TypeScript: branded types](#typescript-branded-types)
- [Bundle size & tree-shaking](#bundle-size--tree-shaking)
- [API reference](#api-reference)
- [Migration](#migration)

---

## Installation

```bash
npm install lyra-audio
# or
pnpm add lyra-audio
```

HLS via [hls.js](https://github.com/video-dev/hls.js) is an optional peer dependency — install it only if you need HLS on non-Safari browsers, and inject the constructor yourself (lyra-audio never imports it):

```bash
pnpm add hls.js
```

---

## Quick start

```typescript
import { Player } from "lyra-audio";

const player = Player.auto();

await player.load("https://example.com/song.mp3");
await player.play(); // call from a user gesture — see Browser support

player.on("timeupdate", ({ currentTime, duration, progress }) => {
  console.log(`${currentTime}s / ${duration}s (${(progress * 100).toFixed(1)}%)`);
});

player.on("ended", () => console.log("Track finished"));

await player.dispose();
```

---

## Browser support & limitations

**Autoplay & the gesture unlock.** Browsers block audio until the user interacts with the page. Call `play()` (or `load({ ..., })` with `autoplay: true`) from within a click/tap handler. If playback is blocked, `play()` rejects with `PlayerErrorCode.PLAYBACK_NOT_ALLOWED`. To warm up the `AudioContext` inside a gesture without starting a track, call `unlockAudio()` (see [AudioContext management](#audiocontext-management)).

> **`autoplay: true` does not fail the load.** When only autoplay is blocked, `load()` still resolves and the player reaches `ready`; a single `PLAYBACK_NOT_ALLOWED` **error event** is emitted and the state stays `ready`. Re-`play()` from a user gesture. (A manual `play()` call still rejects so you can `catch` it.)

**iOS element-volume caveat.** By default (`webAudioRouting: 'always'`) volume is applied by the Web Audio graph, so it works on iOS. If you opt out of routing (`webAudioRouting: 'never'`, or after a CORS fallback), volume falls back to `HTMLMediaElement.volume`, which **iOS Safari ignores** — the element always plays at system volume.

**CORS for EQ / analyser / fades (routed HTML5).** With routing on, a cross-origin URL gets `crossOrigin="anonymous"`, so the server **must** send CORS headers or the media fails to load. Two escapes:
- `webAudioRouting: 'never'` — plain element playback, no graph, no `crossOrigin` (and `player.graph` is `null`).
- `corsFallback: true` — if a routed cross-origin load fails with a media error, retry it once without `crossOrigin` and without the graph (that track loses EQ/analyser/fades).

Both are settable globally in `PlayerOptions` or per call via the second argument to `load()`.

**HLS matrix.**

| Environment | How | Requirement |
| ----------- | --- | ----------- |
| Chrome/Firefox/Edge (MSE) | hls.js | inject `new Player({ Hls })` |
| Safari / iOS | native `HTMLMediaElement` | none (handled automatically) |
| No MSE and no native HLS | unsupported | load errors with `LOAD_NOT_SUPPORTED` |

**Background-tab timing.** `timeupdate` fires about 4×/s in the foreground. Background tabs throttle timers to about 1×/s, so the event fires less often — but the reported values stay accurate because `currentTime` is read from the audio clock, not counted per tick. For smooth animation loops, read `player.currentTime` on demand rather than depending on `timeupdate` cadence.

---

## Choosing a strategy

| Strategy   | Best for                              | Notes                                              |
| ---------- | ------------------------------------- | -------------------------------------------------- |
| `html5`    | streaming, HLS, large files           | lower memory; routed through the graph by default  |
| `webaudio` | decoded buffers, precise timing       | requires a fully decoded `AudioBuffer`             |
| `auto`     | general use (default)                 | URL → `html5`, `ArrayBuffer`/`Uint8Array` → `webaudio` |

`player.mode` returns `"auto"` before the first load, then the resolved strategy (`"html5"` or `"webaudio"`) once a source is loaded.

```typescript
const player = new Player({
  mode: "auto",            // "html5" | "webaudio" | "auto"
  volume: 0.5,             // clamped to 0..1
  muted: false,
  loop: false,
  playbackRate: 1,         // clamped to 0.0625..16
  autoplay: false,
  preload: "auto",         // "none" | "metadata" | "auto"
  preservesPitch: true,
  webAudioRouting: "always", // "always" | "never"
  corsFallback: false,
  latencyHint: "interactive",
});
```

Factory shortcuts:

```typescript
Player.auto(options?);        // mode: "auto"
Player.forMusic(options?);    // mode: "auto",  latencyHint: "playback"
Player.forStreaming(options?);// mode: "html5", latencyHint: "playback", preload: "metadata"
```

---

## Loading sources

`load()` accepts a URL string, a `File`/`Blob`, or an object form. Calling `load()` again cancels any in-progress load.

```typescript
await player.load("https://example.com/track.mp3");     // URL string
await player.load(inputElement.files[0]);               // File
await player.load(someBlob);                            // Blob
await player.load({ data: arrayBuffer });               // ArrayBuffer  → webaudio
await player.load({ data: uint8Array });                // Uint8Array   → webaudio

// URL with custom headers (fetched, then played from a blob URL)
await player.load({
  url: "https://api.example.com/audio/123",
  headers: { Authorization: "Bearer token" },
});

// HLS — a .m3u8 URL is detected automatically, or set type: "hls"
await player.load({ url: "https://example.com/stream.m3u8", type: "hls" });
```

**Per-load overrides.** The optional second argument overrides routing for a single track — useful for mixed playlists where some sources are CORS-enabled and some are not:

```typescript
await player.load(corsEnabledUrl);                          // graph on (default)
await player.load(noCorsUrl, { webAudioRouting: "never" }); // this track: no graph
await player.load(maybeCorsUrl, { corsFallback: true });    // retry un-routed on media error
```

---

## HLS streaming

Inject the `Hls` constructor; lyra-audio treats it as an optional peer dependency and never imports it. On Safari, HLS also plays natively without hls.js.

```typescript
import Hls from "hls.js";
import { Player } from "lyra-audio";

const player = new Player({
  Hls,
  // hlsConfig is Partial<HLSConfig> & Record<string, unknown> — known keys are
  // typed, and any other hls.js option passes straight through to `new Hls()`.
  hlsConfig: { maxBufferLength: 30, maxMaxBufferLength: 60 },
});

await player.load("https://example.com/live/playlist.m3u8");

player.on("qualitiesavailable", (levels) => {
  // QualityLevel[]: [{ index, bitrate, label, codec }, ...]
});

const levels = player.getQualityLevels();
const ok = player.setQuality(levels[0].index); // returns boolean
player.setQuality(-1);                          // -1 = auto (ABR)

player.on("qualitychange", (level) => {
  // fired when the engine actually switches level (see note below)
});
```

> **`setQuality(level)` returns `boolean` and does not emit synchronously.** It returns `false` (no-op) for an invalid index and `true` otherwise; it never emits `qualitychange` on the spot. The real, engine-selected level arrives **asynchronously** via `qualitychange` once hls.js switches — including the ABR-chosen level after `setQuality(-1)`. Don't assume the level changed the instant the call returns; listen for `qualitychange`.

### Live streams

```typescript
if (player.isLive) {
  // Do NOT bind a progress bar to `duration`: on hls.js a live stream reports a
  // finite, growing sliding-window duration (only native HLS/Safari reports
  // Infinity), so `currentTime / duration` creeps upward instead of showing "live".
  hideScrubber();
} else {
  showScrubber(player.currentTime / player.duration);
}
```

`player.isLive` is the reliable signal — not `duration === Infinity`. On a live stream, `seek()` clamps to the seekable window and is a no-op when that window is empty.

---

## Playback control

```typescript
await player.play();      // rejects with PLAYBACK_NOT_ALLOWED if blocked
player.pause();
player.stop();            // pause + reset position to 0 (state → ready)
await player.togglePlay();

player.seek(30);          // seconds (absolute)
player.seekPercent(0.5);  // 0..1 of duration

player.setLoop(true);

player.state;        // PlayerState string
player.currentTime;  // TimeSeconds
player.duration;     // TimeSeconds
player.isPlaying;    // boolean
player.isReady;      // true when ready/playing/paused/buffering
player.isLive;       // boolean (HLS live)
player.mode;         // "auto" before load, then "html5" | "webaudio"
```

`seeking` is emitted synchronously when you call `seek()`. `seeked` fires when the seek actually completes — from the native element event on HTML5 (asynchronous), and synchronously in the Web Audio strategy.

---

## Rate & pitch

```typescript
player.setPlaybackRate(1.5); // clamped to 0.0625..16 (non-finite → 1)
player.playbackRate;         // PlaybackRate

player.setPreservesPitch(true); // applied live to the element and to future loads
player.preservesPitch;          // your intent (boolean)
player.canPreservePitch;        // whether the ACTIVE strategy can actually do it
```

- **HTML5** preserves pitch natively (feature-detected, with `webkit`/`moz` fallbacks); `canPreservePitch` is `true` where supported.
- **Web Audio** shifts pitch with rate by default (resampling) and logs a one-time warning; `canPreservePitch` is `false` — unless you inject a time-stretch plugin (below), then it reports `true`.
- Usable range is roughly `0.5×`–`2×`; extremes degrade quality.

**Time-stretch plugin (Web Audio, optional).** Change tempo without pitch by injecting a `TimeStretchFactory` — dependency-injected exactly like `Hls`, so no WASM/worklet ships in the base bundle. When present and `preservesPitch` is true, the Web Audio source plays at rate 1.0 into the plugin, which owns tempo:

```typescript
import { Player, type TimeStretchFactory } from "lyra-audio";

const timeStretch: TimeStretchFactory = async (ctx) => {
  // wrap your AudioWorklet/WASM node; must implement ITimeStretchNode
  return { node, setRate, getInputPosition, flush, dispose };
};

const player = new Player({ mode: "webaudio", timeStretch });
```

Recommended plugins (not bundled): **SoundTouchJS** worklet (MIT, light) and **Signalsmith Stretch** WASM (MIT, best quality/weight). **Rubber Band** WASM is GPL/commercial — avoid unless your license permits it. Without a plugin, Web Audio resamples (pitch shifts with rate).

> **Position in stretcher mode leads the audible output.** With a plugin
> attached, `player.currentTime` (and `timeupdate`) track how far the source has
> been *consumed*, which runs ahead of what you *hear* by the plugin's internal
> latency — typically **~50–100 ms**. This is inherent to time-stretching and is
> not smoothed away. It's imperceptible for a progress bar, but if you sync
> tightly to audio (waveform playheads, karaoke/lyrics), offset your visuals by
> that latency (or measure it against `AudioContext.currentTime`). `seek()` and
> resume re-anchor the position exactly (the plugin is flushed), so the lead
> only accrues during continuous playback.

---

## Volume & mute

```typescript
player.setVolume(0.8); // clamped to 0..1
player.setMuted(true);
player.toggleMute();

player.volume; // Volume (0..1)
player.muted;  // boolean

player.on("volumechange", ({ volume, muted }) => updateUI(volume, muted));
```

`volume` is clamped to `0..1`; gain above unity is not available. When the graph is routed (the default), volume is applied by the graph and the underlying element/source is pinned to unity — so on routed HTML5, `element.volume` no longer reflects `player.volume`.

---

## Fades

**A fade is a multiplier (0..1) applied on top of `volume`, not a change to `volume`.** Output = `volume × fadeMultiplier`. The two are independent gains: fading does not change `player.volume`, and changing `player.volume` does not cancel a running fade.

```typescript
await player.fadeTo(0.3, 2); // ramp the fade MULTIPLIER to 0.3 over 2s (volume unchanged)
await player.fadeIn(1.5);    // multiplier → 1 (starts playback if paused)
await player.fadeOut(1.0);   // multiplier → 0

await player.fadeOutAndPause(1.0); // fade out, pause, then reset multiplier to 1 while silent
await player.fadeOutAndStop(1.0);  // fade out, stop, then reset multiplier to 1

player.cancelFade();     // stop the ramp where it is
player.isFading;         // boolean
player.fadeMultiplier;   // current multiplier, 0..1 (1 when no graph)
```

> **`fadeOut()` on its own leaves the multiplier at 0 while playback continues.** Audio stays silent, and raising `volume` will **not** restore it (they are separate gains). Recover with `fadeIn()`, or use `fadeOutAndPause()` / `fadeOutAndStop()`, which reset the multiplier to 1 while silent so the next play is at full level.

Fades require a routed graph; if none is present (`webAudioRouting: 'never'` or after a CORS fallback) the fade methods resolve immediately as no-ops.

---

## Equalizer

A 10-band EQ on `BiquadFilterNode`, reached via `player.graph` once a routed load completes (`null` otherwise).

```typescript
const graph = player.graph;
if (!graph) return; // null before load, after dispose, or when un-routed

// Bands: 0=32Hz 1=64Hz 2=125Hz 3=250Hz 4=500Hz 5=1kHz 6=2kHz 7=4kHz 8=8kHz 9=16kHz
graph.setEQBand(0, 6);                          // +6 dB at 32 Hz
graph.setEQBands([6, 4, 2, 0, 0, 0, 0, 2, 4, 6]); // all 10 at once
graph.getEQBand(0);                              // current gain (dB)

graph.setEQEnabled(false); // bands keep their values while bypassed
graph.eqEnabled;           // boolean
graph.resetEQ();           // all bands → 0 dB
graph.bands;               // EQBand[] current config
```

Use `player.graphOrThrow` to skip the null check when you know a routed load has completed (it throws a descriptive error otherwise).

---

## Visualization

`getFrequencyData()` / `getTimeDomainData()` return the **same internal `Uint8Array`** each call — `.slice()` if you need to keep a frame.

```typescript
function draw() {
  const graph = player.graph;
  if (!graph) return;

  const freq = graph.getFrequencyData();   // 0..255 per bin
  const wave = graph.getTimeDomainData();  // 0..255, 128 = silence

  render(freq, wave);
  requestAnimationFrame(draw);
}
draw();

graph.analyzer.fftSize = 4096; // configure the AnalyserNode directly
```

You can also construct an `AudioGraph` with analyser options:

```typescript
import { AudioGraph } from "lyra-audio";
const g = new AudioGraph(audioContext, {
  analyser: { fftSize: 4096, smoothingTimeConstant: 0.85, minDecibels: -90, maxDecibels: -10 },
});
```

---

## Loudness normalization

Normalize per-track loudness toward a target LUFS. It is **off by default** and driven by metadata you supply (lyra-audio does not measure loudness itself). The normalization gain sits inside the graph, so it requires a routed load.

```typescript
const player = new Player({
  loudnessNormalization: {
    enabled: true,
    targetLufs: -16,          // default -16
    preventClipping: true,    // default true (uses truePeak + headroom)
    headroomDb: 1,            // default 1
    maxGainDb: 12,            // default 12  (cap on boost)
    maxAttenuationDb: 24,     // default 24  (cap on cut)
    smoothTimeSec: 0.05,      // default 0.05 (ramp time)
    retainMetadataAcrossLoads: false, // default false (metadata cleared each load)
  },
});

await player.load("https://example.com/track.mp3");

// Supply the track's measured loudness; the gain is (re)computed and ramped in.
player.setLoudnessMetadata({ integratedLufs: -9.5, truePeakDbtp: -0.3 });

player.on("normalizationchange", ({ enabled, gainDb, targetLufs, metadata }) => {
  console.log(`normalization ${enabled ? "on" : "off"}: ${gainDb.toFixed(1)} dB`);
});
```

Runtime controls (each recomputes and re-applies the gain):

```typescript
player.setNormalizationEnabled(true);
player.setTargetLufs(-14);
player.setNormalizationOptions({ maxGainDb: 6 });
player.setLoudnessMetadata({ integratedLufs: -12 });
player.getLoudnessMetadata();          // LoudnessMetadata | null
player.clearLoudnessMetadata();
player.recomputeNormalization();
player.resetNormalization();           // gain → 0 dB, emits normalizationchange(enabled:false)

player.normalizationEnabled;           // boolean
player.targetLufs;                     // number
player.normalizationOptions;           // resolved options
player.getAppliedNormalizationGainDb(); // gain currently on the graph (dB)
```

By default metadata is per-track: it is cleared on every `load()` so a new track starts at 0 dB until you set its metadata. Set `retainMetadataAcrossLoads: true` to carry it across loads (e.g. album-level).

---

## AudioContext management

```typescript
// Warm up / unlock the context inside a user gesture (no track needed).
// Resolves when the context is running, or rejects with PLAYBACK_NOT_ALLOWED
// after ~2s if it never starts. Safe to call repeatedly.
await player.unlockAudio();

await player.freezeAudioContext();    // suspend()
await player.unfreezeAudioContext();  // resume()
player.isAudioContextFrozen();        // boolean (state === "suspended")

await player.getAudioContext();       // resolves a running context (lazy-created)
player.audioContext;                  // the AudioContext (lazy-created on access)

player.on("contextinterrupted", () => {}); // e.g. iOS phone call
player.on("contextresumed", () => {});      // auto-resumed after interruption
```

**Sharing a context across players.** Inject an existing `AudioContext` to stay under iOS context limits or share unlock state:

```typescript
const shared = new AudioContext();
const a = new Player({ audioContext: shared });
const b = new Player({ audioContext: shared });
```

An injected context is used as-is (`latencyHint` is ignored), is **never closed** on `dispose()` (the caller owns its lifecycle — only player-created contexts are closed), and throws `PLAYBACK_FAILED` if it is already closed. lyra-audio registers its state-change listener with `addEventListener`, so your own `onstatechange`/listeners on the shared context are preserved.

---

## Cancellation

Calling `load()` again auto-cancels the in-flight load. For manual control use `CancellationToken`:

```typescript
import { CancellationToken, CancellationError } from "lyra-audio";

let token = new CancellationToken();

async function loadTrack(url: string) {
  token = CancellationToken.replace(token); // cancels the old token, returns a fresh one
  try {
    await token.wrap(player.load(url));
  } catch (err) {
    if (err instanceof CancellationError) console.log("Load cancelled");
  }
}

token.isCancelled;      // boolean
token.cancel();
token.throwIfCancelled(); // throws CancellationError if cancelled
token.signal;             // underlying AbortSignal
```

---

## Events

`player.on(event, cb)` returns an unsubscribe function. `player.waitFor(event, { timeout?, signal? })` returns a Promise.

```typescript
const off = player.on("canplay", () => off());
const { duration } = await player.waitFor("loadedmetadata", { timeout: 5000 });
```

| Event | Payload | Notes |
| ----- | ------- | ----- |
| `loadstart` | — | load began |
| `loadedmetadata` | `{ duration }` | before `canplay` |
| `canplay` | — | ready to start |
| `canplaythrough` | — | enough buffered to finish |
| `play` | — | `play()` was invoked |
| `playing` | — | output actually started |
| `pause` | — | |
| `ended` | — | |
| `stop` | — | `stop()` was invoked |
| `timeupdate` | `{ currentTime, duration, progress }` | ~4×/s (throttled in background tabs) |
| `durationchange` | `TimeSeconds` | |
| `seeking` | `TimeSeconds` | synchronous on `seek()` |
| `seeked` | `TimeSeconds` | HTML5: async native; Web Audio: sync |
| `waiting` | — | buffering started (stalled) |
| `buffered` | — | buffering ended |
| `progress` | `{ buffered, percent }` | reserved — declared in `PlayerEventMap` but not currently emitted |
| `statechange` | `{ from, to }` | |
| `volumechange` | `{ volume, muted }` | |
| `ratechange` | `PlaybackRate` | |
| `qualitiesavailable` | `QualityLevel[]` | HLS |
| `qualitychange` | `QualityLevel` | HLS, async (engine-driven) |
| `normalizationchange` | `{ enabled, gainDb, targetLufs, metadata }` | |
| `contextinterrupted` | — | |
| `contextresumed` | — | |
| `error` | `{ code, message, cause? }` | |
| `dispose` | — | |

---

## Error handling

Errors surface through the `error` event (and `load()`/`play()` also reject) as a `PlayerError` carrying a `PlayerErrorCode`.

```typescript
import { PlayerErrorCode, PlayerError } from "lyra-audio";

player.on("error", ({ code, message, cause }) => {
  switch (code) {
    case PlayerErrorCode.LOAD_ABORTED:       break; // superseded/cancelled — usually ignorable
    case PlayerErrorCode.LOAD_NETWORK:       /* ... */ break;
    case PlayerErrorCode.LOAD_DECODE:        /* ... */ break;
    case PlayerErrorCode.LOAD_NOT_SUPPORTED: /* ... */ break;
    case PlayerErrorCode.PLAYBACK_NOT_ALLOWED: showPlayButton(); break; // gesture required
    case PlayerErrorCode.PLAYBACK_FAILED:    /* ... */ break;
    case PlayerErrorCode.HLS_FATAL:
    case PlayerErrorCode.HLS_NETWORK:
    case PlayerErrorCode.HLS_MEDIA:          /* ... */ break;
    case PlayerErrorCode.UNKNOWN:            /* ... */ break;
  }
});

try {
  await player.load(url);
  await player.play();
} catch (err) {
  if (err instanceof PlayerError) console.error(err.code, err.message, err.cause);
}
```

Note: with `autoplay: true`, a blocked autoplay is reported via one `error` event with `PLAYBACK_NOT_ALLOWED` and does **not** reject `load()` (see [Browser support](#browser-support--limitations)).

---

## Player state

A strict state machine; invalid transitions are ignored with a console warning (never thrown). `disposed` is terminal.

```
idle ──► loading ──► ready ──► playing ⇄ paused
                       ▲          │         │
                       └──────────┴──► buffering

error ◄── loading / ready / playing / paused / buffering   (not idle)
error ──► loading            disposed ◄── any state
```

| State | Meaning |
| ----- | ------- |
| `idle` | initial; nothing loaded |
| `loading` | `load()` in progress |
| `ready` | loaded and ready (also after `stop()`) |
| `playing` | producing output |
| `paused` | paused mid-playback |
| `buffering` | playing but stalled for data |
| `error` | recover by calling `load()` again |
| `disposed` | `dispose()` called — unusable |

```typescript
player.on("statechange", ({ from, to }) => console.log(`${from} → ${to}`));
```

---

## TypeScript: branded types

Public numeric values use branded types so a raw number is not accidentally passed where a validated one is expected. The setter methods (`setVolume`, `seek`, `setPlaybackRate`, …) accept plain `number` and brand internally; the branded factories are for constructing values you pass into event-typed positions.

```typescript
import { createVolume, createTimeSeconds, createPlaybackRate, type Volume } from "lyra-audio";

createVolume(1.5);       // clamped to 1.0
createTimeSeconds(-5);   // clamped to 0
createPlaybackRate(2);   // clamped to 0.0625..16 (non-finite → 1)

const v: Volume = 0.5;              // ✗ TS error
const ok: Volume = createVolume(0.5); // ✓
```

---

## Bundle size & tree-shaking

The published ESM entry is about **20 KB gzipped**. The package sets `"sideEffects": false` and is fully tree-shakeable: importing only `PlayerError` shakes the dist down to under 2 KB (the `Player`, strategies, handlers, `AudioGraph`, and logger all drop out). `hls.js` is an external peer dependency and is never bundled.

---

## API reference

### `Player`

| Member | Type | Description |
| ------ | ---- | ----------- |
| `Player.auto(options?)` | static | factory: `mode: "auto"` |
| `Player.forMusic(options?)` | static | factory: `latencyHint: "playback"` |
| `Player.forStreaming(options?)` | static | factory: HTML5, `preload: "metadata"` |
| `registerHandler(handler)` | `void` | prepend a custom `ISourceHandler` |
| `load(source, loadOptions?)` | `Promise<void>` | load a source; cancels any prior load; optional per-load `{ webAudioRouting, corsFallback }` |
| `play()` | `Promise<void>` | start/resume; rejects `PLAYBACK_NOT_ALLOWED` if blocked |
| `pause()` | `void` | |
| `stop()` | `void` | pause + reset to 0 |
| `togglePlay()` | `Promise<void>` | |
| `seek(seconds)` | `void` | clamps to duration (or live seekable window) |
| `seekPercent(0..1)` | `void` | |
| `setVolume(0..1)` | `void` | clamped |
| `setMuted(bool)` / `toggleMute()` | `void` | |
| `setPlaybackRate(rate)` | `void` | clamped 0.0625..16 |
| `setLoop(bool)` | `void` | |
| `setPreservesPitch(bool)` | `void` | applied live + to future loads |
| `fadeTo(mult, sec?)` | `Promise<void>` | ramp the fade multiplier (0..1) |
| `fadeIn(sec?)` / `fadeOut(sec?)` | `Promise<void>` | multiplier → 1 / → 0 |
| `fadeOutAndPause(sec?)` / `fadeOutAndStop(sec?)` | `Promise<void>` | fade out, then pause/stop, reset multiplier |
| `cancelFade()` | `void` | |
| `unlockAudio()` | `Promise<void>` | resolve when running, else reject `PLAYBACK_NOT_ALLOWED` (~2s) |
| `getAudioContext()` | `Promise<AudioContext>` | resolves a running context |
| `freezeAudioContext()` / `unfreezeAudioContext()` | `Promise<void>` | suspend / resume |
| `isAudioContextFrozen()` | `boolean` | |
| `getQualityLevels()` | `QualityLevel[]` | HLS |
| `setQuality(index)` | `boolean` | `-1` = auto; `false` on invalid index; emits async |
| `getCurrentQuality()` | `number` | `-1` = auto |
| `setLoudnessMetadata(meta \| null)` | `void` | |
| `getLoudnessMetadata()` | `LoudnessMetadata \| null` | |
| `clearLoudnessMetadata()` | `void` | |
| `setNormalizationEnabled(bool)` | `void` | |
| `setTargetLufs(n)` | `void` | |
| `setNormalizationOptions(opts)` | `void` | |
| `recomputeNormalization()` / `resetNormalization()` | `void` | |
| `getAppliedNormalizationGainDb()` | `number` | |
| `dispose()` | `Promise<void>` | |
| `state` | `PlayerState` | |
| `currentTime` / `duration` | `TimeSeconds` | |
| `volume` | `Volume` | `muted` `boolean` |
| `playbackRate` | `PlaybackRate` | `loop` `boolean` |
| `preservesPitch` | `boolean` | your intent |
| `canPreservePitch` | `boolean` | active strategy capability |
| `isPlaying` / `isReady` / `isLive` / `isFading` | `boolean` | |
| `fadeMultiplier` | `number` | 0..1 (1 when no graph) |
| `normalizationEnabled` / `targetLufs` / `normalizationOptions` | | current normalization config |
| `mode` | `PlaybackMode` | `"auto"` before load, then `"html5"`/`"webaudio"` |
| `graph` | `AudioGraph \| null` | routed graph, else `null` |
| `graphOrThrow` | `AudioGraph` | throws if not ready |
| `audioContext` | `AudioContext` | lazy-created |
| `on(event, cb)` | `() => void` | returns unsubscribe |
| `waitFor(event, opts?)` | `Promise` | `{ timeout?, signal? }` |

### `AudioGraph`

| Member | Type | Description |
| ------ | ---- | ----------- |
| `setEQBand(index, dB)` / `setEQBands(dB[])` | `void` | |
| `getEQBand(index)` | `number` | |
| `resetEQ()` / `setEQEnabled(bool)` | `void` | |
| `setVolume(0..1)` / `setVolumeImmediate(0..1)` | `void` | drives the volume gain (clamped) |
| `fadeTo(mult, sec, from?)` | `Promise<void>` | ramp the fade multiplier |
| `cancelFade()` | `void` | |
| `setNormalizationGainDb(dB)` / `setNormalizationGainDbSmooth(dB, sec?)` | `void` | |
| `getNormalizationGainDb()` / `resetNormalization()` | | |
| `getFrequencyData()` / `getTimeDomainData()` | `Uint8Array` | live buffer — copy if storing |
| `eqEnabled` / `isFading` | `boolean` | |
| `fadeMultiplier` | `number` | 0..1 |
| `bands` | `EQBand[]` | |
| `input` / `output` | `AudioNode` | `output` is the volume gain (end of chain) |
| `analyzer` | `AnalyserNode` | |

### `CancellationToken`

| Member | Type | Description |
| ------ | ---- | ----------- |
| `cancel()` | `void` | |
| `isCancelled` | `boolean` | |
| `throwIfCancelled()` | `void` | throws `CancellationError` |
| `wrap(promise)` | `Promise<T>` | rejects `CancellationError` if cancelled |
| `signal` | `AbortSignal` | |
| `CancellationToken.replace(old)` | static | cancels `old`, returns a fresh token |

### Exports

`Player`, `PlayerError`, `PlayerErrorCode`, `CancellationToken`, `CancellationError`, `AudioGraph`, `normalizeSource`, `DEFAULT_OPTIONS`, `createVolume`/`createTimeSeconds`/`createPlaybackRate`, and the types `PlayerOptions`, `LoadOptions`, `PlayerState`, `PlaybackMode`, `AudioFormat`, `AudioSourceType`, `AudioSource`, `AudioSourceInput`, `QualityLevel`, `HLSConfig`, `Volume`/`TimeSeconds`/`PlaybackRate`, `PlayerEventMap`, `PlayerEventName`, `TimeUpdatePayload`, `VolumeChangePayload`, `BufferPayload`, `ErrorPayload`, `ITimeStretchNode`, `TimeStretchFactory`.

**Advanced / internal-ish exports** (for extension and testing; most apps only need `Player`): `EventEmitter`, `StateManager`, `HTML5Strategy`, `WebAudioStrategy`, `SourceManager`, `UrlHandler`, `BlobHandler`, `BufferHandler`, `HLSHandler`, `NativeHlsHandler`, and the types `IPlaybackStrategy`, `StrategyInitOptions`, `PlaybackStrategyEvents`, `ISourceHandler`, `PreparedSource`, `SourceCapabilities`.

---

## Migration

Several contracts changed since early versions — see the [CHANGELOG](./CHANGELOG.md) for the full list and upgrade notes. Highlights: `load()` no longer rejects when only autoplay is blocked; `fadeTo`/`fadeOut` drive a fade **multiplier** independent of `volume`; `setQuality()` returns `boolean` and emits `qualitychange` asynchronously; `mode` returns `"auto"` before the first load.
