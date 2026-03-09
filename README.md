# lyra-audio

A flexible, lightweight audio player library for the browser. Supports both **Web Audio API** and **HTML5 Audio** playback strategies, with optional **HLS streaming** via [hls.js](https://github.com/video-dev/hls.js).

## Features

- 🎵 **Dual playback strategies** — HTML5 Audio for streaming, Web Audio API for precise control
- 📡 **HLS streaming** — optional support via hls.js (peer dependency)
- 🎛️ **Built-in 10-band EQ** — with enable/disable toggle
- 📊 **Audio analysis** — frequency and time-domain data via AnalyserNode
- 🔊 **Volume, mute, playback rate, loop** — full playback control
- 📦 **Multiple source types** — URL, Blob, File, ArrayBuffer, Uint8Array, HLS
- 🛡️ **Cancellation support** — safe loading cancellation with CancellationToken
- 📝 **TypeScript first** — full type definitions included

## Installation

```bash
npm install lyra-audio
```

For HLS support, also install hls.js:

```bash
npm install hls.js
```

# Quick Start

## Basic Usage

```typescript
import { Player } from "lyra-audio";

const player = Player.auto();

await player.load("https://example.com/song.mp3");
await player.play();

// Control playback
player.pause();
player.seek(30); // Seek to 30 seconds
player.setVolume(0.8); // 80% volume
player.setPlaybackRate(1.5);
player.toggleMute();

// Listen to events
player.on("timeupdate", ({ currentTime, duration, progress }) => {
  console.log(
    `${currentTime}s / ${duration}s (${(progress * 100).toFixed(1)}%)`,
  );
});

player.on("ended", () => {
  console.log("Track finished");
});

// Clean up
await player.dispose();
```

## Factory Methods

```typescript
import { Player } from "lyra-audio";

// Auto-detect best strategy
const player1 = Player.auto();

// Optimized for music playback
const player2 = Player.forMusic();

// Optimized for streaming (HTML5 only)
const player3 = Player.forStreaming();

// Full control
const player4 = new Player({
  mode: "webaudio",
  volume: 0.5,
  autoplay: true,
  loop: true,
  latencyHint: "playback",
});
```

## Loading Different Sources

```typescript
// URL string
await player.load("https://example.com/track.mp3");

// File from input
const file = inputElement.files[0];
await player.load(file);

// Blob
await player.load(someBlob);

// ArrayBuffer
await player.load({
  data: arrayBuffer,
});

// URL with custom headers
await player.load({
  url: "https://api.example.com/audio/123",
  headers: { Authorization: "Bearer token" },
});

// HLS stream (requires hls.js)
await player.load({
  url: "https://example.com/stream/playlist.m3u8",
  type: "hls",
});
```

## HLS Streaming

```typescript
import Hls from "hls.js";
import { Player } from "lyra-audio";

const player = new Player({
  Hls, // Pass the Hls constructor
  hlsConfig: {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
  },
});

await player.load("https://example.com/live/playlist.m3u8");

// Quality levels
player.on("qualitiesavailable", (levels) => {
  console.log("Available qualities:", levels);
});

const levels = player.getQualityLevels();
player.setQuality(levels[0].index); // Select specific quality
```

## Equalizer

```typescript
const player = Player.auto();
await player.load("https://example.com/song.mp3");

const graph = player.graph;

if (graph) {
  // Set individual band gain (-40 to 40 dB)
  graph.setEQBand(0, 6); // Boost 32Hz by 6dB
  graph.setEQBand(9, -3); // Cut 16kHz by 3dB

  // Set all bands at once
  graph.setEQBands([6, 4, 2, 0, 0, 0, 0, 2, 4, 6]);

  // Toggle EQ on/off
  graph.setEQEnabled(false);
  graph.setEQEnabled(true);

  // Reset all bands to 0
  graph.resetEQ();
}
```

## Audio Visualization

```typescript
const graph = player.graph;

function draw() {
  if (!graph) return;

  // Frequency spectrum (0-255 per bin)
  const freqData = graph.getFrequencyData();

  // Waveform (0-255, 128 = silence)
  const timeData = graph.getTimeDomainData();

  // Draw to canvas...
  requestAnimationFrame(draw);
}

draw();
```

## Events

```typescript
// Lifecycle
player.on("loadstart", () => {});
player.on("loadedmetadata", ({ duration }) => {});
player.on("canplay", () => {});

// Playback
player.on("play", () => {});
player.on("playing", () => {});
player.on("pause", () => {});
player.on("ended", () => {});
player.on("stop", () => {});

// Progress
player.on("timeupdate", ({ currentTime, duration, progress }) => {});
player.on("durationchange", (duration) => {});
player.on("seeking", (time) => {});
player.on("seeked", (time) => {});

// Buffering
player.on("waiting", () => {}); // Buffering started

// State
player.on("statechange", ({ from, to }) => {});

// Volume
player.on("volumechange", ({ volume, muted }) => {});
player.on("ratechange", (rate) => {});

// Quality (HLS)
player.on("qualitiesavailable", (levels) => {});
player.on("qualitychange", (level) => {});

// Errors
player.on("error", ({ code, message, cause }) => {});

// Cleanup
player.on("dispose", () => {});

// One-time listener
const unsubscribe = player.on("canplay", () => {
  console.log("Ready!");
  unsubscribe(); // Remove listener
});

// Wait for event (Promise-based)
const { duration } = await player.waitFor("loadedmetadata", {
  timeout: 5000,
});
```
