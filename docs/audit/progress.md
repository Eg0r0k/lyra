# Progress Log

> Update after every completed task: status, commit hash, date, one-line note.
> Statuses: TODO / IN PROGRESS / DONE / DEFERRED / BLOCKED.
> Execution order per amendments.md: T-01 → T-02 → T-06 → T-03 → T-04 → T-05 → rest.

| Task | Title | Status | Commit | Date | Notes |
|------|-------|--------|--------|------|-------|
| T-01 | Stale-load error gating + AbortSignal into strategies | DONE | (see follow-up) | 2026-07-18 | Catch gated by signal identity (swallow stale); `StrategyInitOptions.signal` required + threaded into both strategies; html5 waiters abort-aware; dispose detaches init waiters. +4 tests, mock empty-src error + deferred decode. |
| T-02 | Load-generation guard; autoplay decoupled from load() | TODO | | | breaking → major |
| T-06 | Playwright matrix + local HLS fixtures | TODO | | | moved before T-03/T-04 |
| T-03 | Native HLS path for Safari/iOS | TODO | | | |
| T-04 | Web Audio routing policy + CORS rework | TODO | | | amended: no auto-retry |
| T-05 | HLS runtime errors + recovery | TODO | | | |
| T-07 | ESLint flat config | TODO | | | |
| T-08 | pause/togglePlay during buffering | TODO | | | |
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
