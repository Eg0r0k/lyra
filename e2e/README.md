# Browser tests (Playwright)

Real-engine suite for things jsdom cannot cover: real decode, real HLS, native
HLS capability, and gesture/autoplay behavior. Kept separate from the vitest
(jsdom) unit suite.

## Run

```sh
pnpm test:browser        # builds dist/ first, then runs Playwright
# one engine:
pnpm exec playwright test --project=chromium
```

`pnpm test` stays jsdom-only. Browser tests need the browsers installed once:

```sh
pnpm exec playwright install chromium firefox webkit
```

Fixtures are served locally by `e2e/server.mjs` (started automatically by the
Playwright `webServer`). **No network access is required** — HLS runs entirely
from checked-in fixtures.

## Fixture server origins

- App origin `http://localhost:4173` — harness page, `/dist/*`, `/vendor/hls.mjs`,
  and `/fixtures/*` (same-origin, also sends `Access-Control-Allow-Origin: *`).
- Cross origin `http://localhost:4174` — for T-04 CORS work:
  - `/cors/*` → fixtures **with** `Access-Control-Allow-Origin: *`
  - `/nocors/*` → fixtures **without** any CORS header

## Engine capability matrix (Playwright on this platform)

| Capability | chromium | firefox | webkit (Windows build) |
|---|---|---|---|
| PCM WAV `<audio>` + Web Audio decode | yes | yes | **no Web Audio API** (`window.AudioContext` undefined) |
| MSE HLS via hls.js | yes | (not exercised) | no MSE |
| Native HLS (`canPlayType('application/vnd.apple.mpegurl')`) | "" | "" | **""** (no native HLS) |
| Autoplay blocking enforced in automation | **no** | n/a | n/a |

Consequences, verified by probing the actual builds (not assumed):

- **WebKit-on-Windows has no Web Audio API and no native HLS.** Graph-routed
  playback (`webAudioRouting:'always'`, the default) and hls.js/native HLS
  cannot run under this build. WebKit therefore runs:
  - `native-hls.spec.ts` — the honest `LOAD_NOT_SUPPORTED` negative, and
  - `routing.spec.ts` — **plain html5 playback via `webAudioRouting:'never'`**
    (no `AudioContext`), which works here and proves the T-04 'never' path.

  Real Safari/iOS graph + native-HLS playback stays a manual check.
- **Autoplay blocking is not enforced** by Playwright's engines here. Verified
  against an *audible* 440 Hz tone (autoplay policies allow inaudible/silent
  media, so silence is not a valid probe): a raw `<audio>.play()` still resolves
  and `AudioContext` auto-runs without a gesture in
    - Chromium, even with `ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required']`
      plus an explicit `--autoplay-policy=document-user-activation-required`,
      headless and headed; and
    - Firefox, with `media.autoplay.default=1` (+ `blocking_policy=2`), headless
      and headed.

  (`ignoreDefaultArgs: true` — stripping every default to force the policy — just
  breaks the launch, since Playwright's connection args go too.) `unlock.spec.ts`
  probes with the tone and **skips** with a reason when blocking is not enforced;
  the assertions run automatically on any build that does enforce the policy.

## Native HLS — three-tier verification scheme

Native HLS (Safari/iOS `.m3u8` via a plain media element) cannot be exercised in
any CI-available engine on this machine, so it is verified in three tiers:

1. **Unit (jsdom)** — handler selection with `canPlayType` mocked truthy. Lands
   with T-03 (`NativeHlsHandler` selected when MSE is unavailable).
2. **e2e honest negative** — `native-hls.spec.ts` (WebKit): with no hls.js and no
   native HLS, an `.m3u8` load rejects with `LOAD_NOT_SUPPORTED`. Also asserts
   `canPlayType(...) === ""` to document the platform gap. Stays valid after T-03
   (the native handler only engages when `canPlayType` is truthy).
3. **Manual** — real native-HLS playback on iOS Safari / macOS Safari (below).

## Manual verification checklist (real devices/browsers)

These cannot run in Playwright on Windows and must be checked by hand before
release:

- **iOS Safari / macOS Safari native HLS**: load an `.m3u8` with **no** hls.js
  injected → plays via the media element; `player.mode === "html5"`.
- **Gesture unlock**: with a fresh page (no interaction), `play()` rejects with
  `PLAYBACK_NOT_ALLOWED`; after a tap/click it succeeds.
- **iOS element volume** (post T-10): volume via the graph works even though
  `HTMLMediaElement.volume` is read-only on iOS.
- **Pitch preservation** (T-23): play a tone at `playbackRate` 1.5 with
  `preservesPitch:true` (default) → pitch unchanged, only tempo; toggle
  `setPreservesPitch(false)` **mid-playback** → pitch audibly rises immediately
  (proves the toggle hits the live element, not just the next load). jsdom/
  Playwright can assert the element property but cannot "hear" pitch.

## CI note

No CI pipeline exists in this repo. To wire one later: `pnpm build && pnpm test:browser`.
