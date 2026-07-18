# e2e fixtures

Tiny, checked-in media used by the Playwright browser suite. All are **2 s of
silence, mono, low bitrate** so they stay in the kilobytes range.

Regenerate with `ffmpeg` (any recent build):

## `silence.wav` — PCM WAV (uncompressed)

Primary cross-engine playback + `decodeAudioData` fixture. PCM is license-free
and decodes in every engine (including the Windows Playwright WebKit build,
which lacks proprietary-codec decoders). Chosen over MP3/AAC after probing
`canPlayType` across chromium/firefox/webkit.

```sh
ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -t 2 -c:a pcm_s16le silence.wav
```

## `tone.wav` — audible PCM WAV (440 Hz sine)

Used only by `unlock.spec.ts` to detect whether the engine enforces autoplay
blocking. Autoplay policies allow *inaudible* media, so the silence fixture
would falsely report "not blocked"; an audible tone is required for an accurate
probe.

```sh
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=8000:duration=2 -c:a pcm_s16le tone.wav
```

## `hls/vod.m3u8` (+ `init.mp4`, `seg_*.m4s`) — HLS VOD, fMP4/AAC

MSE HLS fixture for the hls.js path (exercised under Chromium only). Segment
URIs in the playlist are **relative** so the fixture survives test-server port
changes.

```sh
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 2 -c:a aac -b:a 24k \
  -hls_segment_type fmp4 -hls_time 1 -hls_list_size 0 \
  -hls_fmp4_init_filename init.mp4 -hls_segment_filename "hls/seg_%d.m4s" \
  hls/vod.m3u8
```

## `hls/live.m3u8` — live-window variant (for T-15)

Hand-derived from `vod.m3u8`: **identical segments/init, but with
`#EXT-X-ENDLIST` removed**. hls.js reports a playlist as live purely by the
absence of `#EXT-X-ENDLIST`; ffmpeg cannot statically emit a "true" live
playlist, so this is built by hand from the VOD segments. The e2e suite asserts
hls.js actually reports `live === true` on this file (see `hls.spec.ts`) so
T-15 tests the intended behavior. A dynamic sliding-window variant can be
served by the fixture server later if a moving live edge is needed.
