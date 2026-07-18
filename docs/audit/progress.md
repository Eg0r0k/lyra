# Progress Log

> Update after every completed task: status, commit hash, date, one-line note.
> Statuses: TODO / IN PROGRESS / DONE / DEFERRED / BLOCKED.
> Execution order per amendments.md: T-01 → T-02 → T-06 → T-03 → T-04 → T-05 → rest.

| Task | Title | Status | Commit | Date | Notes |
|------|-------|--------|--------|------|-------|
| T-01 | Stale-load error gating + AbortSignal into strategies | DONE | b9d3f8b | 2026-07-18 | Catch gated by signal identity (swallow stale); `StrategyInitOptions.signal` required + threaded into both strategies; html5 waiters abort-aware; dispose detaches init waiters. +4 tests, mock empty-src error + deferred decode. |
| T-02 | Load-generation guard; autoplay decoupled from load() | DONE | ecf0a2b | 2026-07-18 | breaking → major (load() no longer rejects on autoplay block). play() captures strategy+signal, bails silently when superseded; autoplay branch swallows play() error (single PLAYBACK_NOT_ALLOWED emit, state stays ready). +3 tests, mock deferred-play hook. README note deferred to T-25. |
| T-06 | Playwright matrix + local HLS fixtures | DONE | 27759d0 | 2026-07-18 | e2e/ scaffold: 3 engines + strict-autoplay project, dual-origin fixture server (CORS/no-CORS), tiny ffmpeg fixtures (WAV 32K + fMP4/AAC HLS VOD + live no-ENDLIST). Seed suite 7 pass +1 documented skip. Probed engines: WebKit-Win has NO Web Audio & NO native HLS; Chromium automation doesn't enforce autoplay block. Native-HLS 3-tier scheme + manual notes in e2e/README.md. WAV chosen over MP3/AAC via codec probe. |
| T-03 | Native HLS path for Safari/iOS | DONE | 9d51b21 | 2026-07-18 | New NativeHlsHandler (id `hls-native`): canHandle = isHlsSource && canPlayType('application/vnd.apple.mpegurl'), preferredStrategy html5, prepare {sourceUrl}, getCapabilities {qualityLevels:[],isLive:false}, probe cached per instance. Registered after HLSHandler, before Buffer. Shared `isHlsSource` (hls-source.ts) reused by HLSHandler/SourceManager. Actionable LOAD_NOT_SUPPORTED (mentions hls.js + native). Exported from barrel. +4 tests (3 selection + 1 Player load), test-utils setNativeHlsSupport hook. e2e honest-negative (webkit) still green. |
| T-04 | Web Audio routing policy + CORS rework | TODO | | | amended: no auto-retry. After implementing, revert to e2e and enable WebKit playback via `webAudioRouting: 'never'` (plain html5, no AudioContext) — best e2e proof the option works, since WebKit-Win has no Web Audio. Cross-origin CORS routes ready in e2e/server.mjs (`:4174` /cors + /nocors). |
| T-05 | HLS runtime errors + recovery | TODO | | | |
| T-07 | ESLint flat config | TODO | | | |
| T-08 | pause/togglePlay during buffering | TODO | | | also closes F-34 (author runtime obs): EXPAND FSM table with `ready→buffering` + `paused→buffering` (buffering happens at initial stall / resume), keep `waiting` emitter unguarded so state reflects it. Direction corrected from emitter-guard after review. Folded into T-08 spec. |
| T-09 | Unified HTML5 readiness waiter | TODO | | | |
| T-10 | Volume/fade gain split | TODO | | | breaking → major |
| T-11 | Harden unlockAudio + auto-resume | TODO | | | |
| T-12 | Clear loudness metadata on load | TODO | | | |
| T-13 | Explicit mode wins over handler preference | TODO | | | |
| T-14 | Handler lifecycle: reset vs dispose | TODO | | | optional-with-fallback |
| T-15 | Live HLS: isLive, Infinity, seekable | TODO | | | |
| T-16 | hlsConfig passthrough + setQuality polish | TODO | | | |
| T-17 | Smooth EQ param updates | TODO | | | |
| T-18 | Seek/timeupdate parity | TODO | | | |
| T-19 | Injectable AudioContext | TODO | | | |
| T-20 | Element/source-node reuse | DEFERRED | | | excluded per amendments.md |
| T-21 | sideEffects + size tracking | TODO | | | |
| T-22a | PlaybackRate clamp, logger, transition logging | TODO | | | |
| T-22b | Remove ReadableStream from AudioSource.data | TODO | | | breaking → major, with T-26 |
| T-23 | Explicit preservesPitch (HTML5) | TODO | | | |
| T-24 | Time-stretch plugin API (WebAudio) | TODO | | | interface + DI only |
| T-25 | README overhaul | TODO | | | after deps |
| T-26 | Release hygiene: CHANGELOG, major, Migration | TODO | | | NEW, runs last |
