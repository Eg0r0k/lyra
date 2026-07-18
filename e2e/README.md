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

- **WebKit-on-Windows has no Web Audio API and no native HLS.** Because the
  library routes all playback through an `AudioContext`, no playback path can run
  under this WebKit build. WebKit therefore only runs the honest native-HLS
  negative (`native-hls.spec.ts`). Real Safari/iOS playback is a manual check.
- **Autoplay blocking is not enforced** by Playwright's Chromium here (a raw
  `<audio>.play()` resolves and `AudioContext` auto-runs without a gesture, even
  with `--autoplay-policy=document-user-activation-required`). `unlock.spec.ts`
  detects this and **skips** with a reason; if a future build enforces the
  policy the assertions run automatically.

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

## CI note

No CI pipeline exists in this repo. To wire one later: `pnpm build && pnpm test:browser`.
