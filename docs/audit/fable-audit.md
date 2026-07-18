# lyra-audio — Architectural Audit (Fable)

> Reference document for implementation. Read together with `amendments.md`,
> which OVERRIDES this file where they conflict. Track progress in `progress.md`.

## Part A. Executive Summary

The library is architecturally sound for its size: clean Strategy+Handler split, typed events, a real FSM, per-load AbortSignal threading. The load pipeline, EQ/fade graph, and cancellation core are genuinely good. The problems cluster in four places:

1. iOS Safari cannot play HLS at all. HLSHandler.canHandle requires Hls.isSupported() (false on iOS — no MSE), and UrlHandler.canHandle explicitly rejects .m3u8. There is no native-HLS path. For an "HLS streaming" library this is the top defect.
2. The HTML5 pipeline is unconditionally routed through Web Audio (setupAudioGraph → createMediaElementSource on every load), and crossOrigin="anonymous" is forced in the default auto mode. Cross-origin files without CORS headers fail to load entirely; a suspended AudioContext silences plain HTML5 playback.
3. Race/error-contract gaps in load()/play(): non-abort errors from a superseded load are not gated by signal identity (spurious error state corrupting the new load); autoplay-blocked play() makes a successful load() reject with duplicate error events; a runtime-fatal HLS error after load silently destroys the stream.
4. Volume/fade share one GainNode and diverge from player.volume; HTML5 volume goes to element.volume, which iOS ignores.

Recommended workflow: fix the P0 correctness block (T-01…T-05) first, stand up the Playwright + local-HLS test infra (T-06), then the P1 fixes, then features (pitch-preserving rate) and the README overhaul last, after the API settles.

> **AMENDED:** see amendments.md — T-06 moves BEFORE T-03/T-04. Actual order: T-01 → T-02 → T-06 → T-03 → T-04 → T-05 → rest.

## Part B. Findings

| ID | Module | Problem | Severity | Confidence | TODO |
|----|--------|---------|----------|------------|------|
| F-01 | HLSHandler / UrlHandler | No native-HLS fallback; iOS Safari (no MSE) cannot play .m3u8 — UrlHandler.canHandle rejects it, HLSHandler needs Hls.isSupported() | critical | supported by code | T-03 |
| F-02 | Html5AudioStrategy.initialize / Player.load (requiresCrossOrigin) | crossOrigin="anonymous" forced for all cross-origin URLs in auto/webaudio mode → media without ACAO headers fails to load at all | high | supported by code | T-04 |
| F-03 | Player.setupAudioGraph | HTML5 always routed via createMediaElementSource on a lazily-created AudioContext → suspended context = silence; AudioContext created even for pure streaming | high | supported by code | T-04 |
| F-04 | Player.load autoplay path | Blocked autoplay → play() throws inside load() → load() rejects, two error events, invalid ready→error transition warning | high | supported by code | T-02 |
| F-05 | Player.load catch | Non-abort errors from a superseded load are not gated by isCurrentLoad() → stale rejection (e.g. element error after dispose() sets src="") flips state to error mid-way through the new load; new load then can't reach ready (error→ready invalid) | high | supported by code | T-01 |
| F-06 | Player.play/pause/stop | No load-generation guard: play() resolving after a newer load() transitions playing from loading (warn-ignored) or plays a disposed strategy | high | supported by code | T-02 |
| F-07 | HLSHandler.prepare ERROR listener | After prepare resolves, a fatal HLS error rejects an already-settled promise (no-op) and cleanup() destroys hls silently — no player error event, no recovery (recoverMediaError/startLoad) | high | supported by code | T-05 |
| F-08 | HLSHandler.getCapabilities / branded.TimeSeconds | isLive hardcoded false; live duration=Infinity → TimeSeconds(∞)→0 → progress/seek/UI nonsense for live streams | high | supported by code | T-15 |
| F-09 | Html5AudioStrategy.initialize (sourceUrl path) | No timeout and no AbortSignal in the canplay waiter → stalled network hangs load() indefinitely; cancellation can't reject it directly | medium | supported by code | T-01, T-09 |
| F-10 | Player.pause / togglePlay | Guard is("playing") → pause() is a no-op in buffering state, though FSM allows buffering→paused | medium | supported by code | T-08 |
| F-11 | Player.setVolume (HTML5 path) | iOS ignores HTMLMediaElement.volume → volume control silently dead on iOS in html5 strategy | medium-high | likely (platform behavior) | T-10 |
| F-12 | AudioGraph.fadeTo | Fade completion driven by setTimeout → background-tab throttling delays fadeOutAndPause/Stop pause by seconds+ (audio already silent, element keeps "playing") | medium | supported by code + platform | T-10 (documented, risk accepted for timer) |
| F-13 | Player / AudioGraph | Fade and volume share _outputGain; fadeTo(0.3) changes audible level but player.volume still reports the old value; next setupAudioGraph/fadeIn restores _volume, not the fade target | medium | supported by code | T-10 |
| F-14 | Player.load strategy override | BufferHandler.preferredStrategy()==='webaudio' hard-overrides an explicit mode:'html5', though BufferHandler supports html5 via blob URL | medium | supported by code | T-13 |
| F-15 | Player.cleanup / SourceManager | Singleton handlers are dispose()d after every load, then reused on the next load — lifecycle contract contradiction (benign today only because disposes are idempotent) | medium | supported by code | T-14 |
| F-16 | Player.unlockAudio | Resolves only via onended; on a non-running context it never fires → promise hangs, _isAudioUnlocking latch wedges all future calls; method undocumented | medium | supported by code | T-11 |
| F-17 | Player.audioContext onstatechange | void this.unfreezeAudioContext() — resume() rejection (iOS after call, no gesture) → unhandled rejection, no retry path | medium | supported by code | T-11 |
| F-18 | Player.cleanup | _loudnessMetadata survives load() → previous track's normalization gain applied to the next track | medium | supported by code | T-12 |
| F-19 | HLSHandler.prepare config | Only 5 keys forwarded to new Hls(); startFragPrefetch typed but dead; arbitrary hls.js options impossible | medium | supported by code | T-16 |
| F-20 | Player.setQuality | setQuality(-1) (auto) never emits qualitychange; no index validation | low | supported by code | T-16 |
| F-21 | AudioGraph.setEQBand | setValueAtTime on gain → zipper noise while dragging EQ sliders (vs setTargetAtTime used in setEQEnabled) | low | supported by code | T-17 |
| F-22 | WebAudioStrategy.seek / timeupdate | Seek pause+play emits spurious pause/play events (webaudio only); timeupdate 60 Hz rAF vs native ~4 Hz; rAF frozen in background tabs → timeupdate stops while audio continues | medium-low | supported by code | T-18 |
| F-23 | Player | One AudioContext per Player, no injection/sharing → iOS context-count limits, multi-player apps | medium | supported by code (API gap) | T-19 |
| F-24 | Html5AudioStrategy lifecycle | New Audio() + new MediaElementAudioSourceNode per load; churn/leak pressure in long playlist sessions (Chrome historically retains these) | low-medium | likely | T-20 |
| F-25 | package.json | No "sideEffects": false → weaker consumer tree-shaking | low | supported by code | T-21 |
| F-26 | branded.PlaybackRate | PlaybackRate(0) → 1, PlaybackRate(0.01) → 0.0625 — inconsistent clamping | low | supported by code | T-22 |
| F-27 | types.AudioSource | ReadableStream<Uint8Array> advertised in data but no handler accepts it → guaranteed LOAD_NOT_SUPPORTED | low | supported by code | T-22 |
| F-28 | Player.seek | seeked emitted synchronously (HTML5 seek is async); seek clamped to 0 when duration unknown (pre-metadata / live) | low-medium | supported by code | T-18 |
| F-29 | tooling | pnpm lint broken (ESLint 10, no flat config) | low | supported by repo | T-07 |
| F-30 | README | No sections for loudness normalization, unlockAudio/context management, contextinterrupted/resumed + normalizationchange events, browser limitations, bundle size; mode doc omits 'auto' return | medium | supported by README | T-25 |
| F-31 | Player / StateManager | transition() return value ignored everywhere → silent divergence between intended and actual state | medium | supported by code | T-22 |
| F-32 | strategies | Rate contract diverges: html5 preserves pitch (default preservesPitch), webaudio resamples (pitch shifts). Undocumented, no capability flag, no time-stretch path | medium | supported by code | T-23, T-24 |
| F-33 | HLSHandler constructor | Raw console.debug bypasses playerLogger | low | supported by code | T-22 |
| F-34 | StateManager `VALID_TRANSITIONS` / Player.bindStrategyEvents (`waiting` handler) | The FSM lists `buffering` as reachable only from `playing`, but buffering physically occurs at the **initial stall** too: `play()` transitions to `playing` only after `await strategy.play()` resolves, so a `waiting` event that arrives first lands while state is still `ready` (or `paused` on resume). The `waiting` handler's `transition("buffering")` then warns ("Invalid state transition: `ready`/`paused` -> `buffering`") **and** the state never reflects buffering — a UI bound to `player.state === "buffering"` shows nothing on a frozen player at startup. Root cause is the table being too restrictive, not the emitter. Fix direction: allow `ready→buffering` and `paused→buffering` (return paths from `buffering` already exist: `playing`/`paused`/`ready`/`error`/`idle`/`disposed`); keep the emitter unguarded so the state reflects the stall. Only `HTML5Strategy` emits `waiting` (decoded WebAudio buffers never stall). `loading→buffering` is not needed — `bindStrategyEvents → … → transition("ready")` is synchronous, so no `waiting` is delivered while state is `loading`. | low | **author runtime observation (not static analysis)** — surfaced in T-06 browser runs, confirmed against the FSM table and the play() ordering | T-08 |
| F-35 | StateManager `VALID_TRANSITIONS` / Player.handleRuntimeError | The FSM allows `→ error` only from `loading`/`playing`/`buffering` — **not** from `ready` or `paused`. A runtime error surfaced while paused (fatal HLS error whose retries exhaust after the user paused / lost network) or while ready (error after `load()` before `play()`) calls `transition("error")` which is rejected (warn), yet `handleRuntimeError` still `emit("error")`s — so the consumer gets an error event while `player.state` stays `paused`/`ready`: contradictory. Same root cause as F-34 (table lags reality; compounded by F-31, ignored transition return). Fix: add `ready→error` and `paused→error` to the table. | medium | **author review of T-05 (design-note follow-up)** — confirmed against the FSM table + handleRuntimeError | T-08 |

## Part C. Justifications

### 1. Cross-browser stability

Safari/iOS — real problems:

- AudioContext gating of HTML5 audio (F-03). Player.load() calls setupAudioGraph() unconditionally, which touches the audioContext getter, creating a context even in html5 mode, and pipes the element through createMediaElementSource. When the context is suspended (created outside a gesture), the element produces silence — the source node captures its output and the graph isn't rendering. play() does await this.getAudioContext() which resumes, so the gesture-driven happy path works, but any programmatic play, or a Safari resume rejection, silences html5 playback that would otherwise have worked. Probability: high for apps that create/load players before first interaction. Fix direction: make Web Audio routing a policy (T-04), not an invariant.
- Forced crossOrigin (F-02). requiresCrossOrigin is true in the default auto mode, so every cross-origin URL gets crossOrigin="anonymous". A server without Access-Control-Allow-Origin then fails the media load outright — worse than the tainted-source alternative (playback works, analyser reads zeros). Probability: high for arbitrary CDN URLs. Fix: set crossOrigin only when graph routing is actually wanted, and fall back to un-routed plain playback (graph features disabled, one warning) on CORS media error.
- iOS element.volume read-only (F-11). Player.setVolume for html5 writes element.volume. On iOS this is silently ignored. Since the element is already routed through the graph, volume can be applied at a graph gain node instead — which T-10's volume/fade split makes possible.
- interrupted handling exists and is decent (auto-resume + clock resync via resyncStartTime). Two gaps: the voided resume() rejection (F-17), and _isAudioUnlocked never resetting when a closed context is recreated in getAudioContext().
- Context-count limits (F-23). One context per Player; old iOS caps concurrent contexts (~4). No audioContext injection option. Real for multi-player pages.
- unlockAudio (F-16) hangs on a non-running context: the silent-buffer onended never fires, the promise never settles, and _isAudioUnlocking stays true so every later call returns immediately without unlocking. Fix: resolve on ctx.state === 'running' (statechange + timeout), reset the latch in a finally.

Firefox — mostly theoretical here: decodeAudioData is stricter with malformed ID3/MP3 framing and AAC-in-MP4 depends on platform codecs (older Linux builds) — the LOAD_DECODE mapping already handles this correctly; nothing to fix beyond browser-matrix tests. MediaElementAudioSourceNode can't be moved between contexts — the code never attempts that (new element per load). linearRampToValueAtTime use in setNormalizationGainDbSmooth correctly anchors with setValueAtTime(gain.value, now) first — the classic Firefox ramp-from-stale-value bug is avoided. currentTime precision reduction (privacy) only affects the rAF timeupdate granularity — irrelevant.

Linux (Pulse/PipeWire) — real but minor: resume-after-suspend glitch/pop and device "wake-up" latency are audio-server behaviors the library can't fix; the correct mitigations already half-exist (latencyHint: 'playback' in forMusic). Worth: never suspend/resume around fades, and a docs note. baseLatency/outputLatency are not exposed — optional getter, not a defect.

General races — real, the core of the P0 block:

- F-05: the catch in load() gates only abort-shaped errors by isCurrentLoad(). Non-abort stale errors (canonical trigger: HTML5Strategy.dispose() sets src="" + load(), firing an async error event that rejects the old initialize-waiter with LOAD_NOT_SUPPORTED) unconditionally transition("error") and emit — while load B is in loading. loading→error is valid, so it lands; B later fails error→ready, leaving a successfully loaded player stuck in error. Fix: gate the entire catch by signal identity, and thread signal into initialize() so cancellation rejects as an abort.
- F-04/F-06: autoplay-block is the most common runtime failure in production and currently produces the worst behavior (load rejection + duplicate errors + FSM warning). load() must resolve once the source is ready; autoplay failure is a separate, identifiable signal.
- F-12: fades resolve via throttled timers; the ramp itself is audio-thread and safe, so the only artifact is a late pause() on an already-silent element. Accepted risk after T-10 documents it — alternatives (worklet-based clock) cost far more than they buy.

### 2. HLS module

- MSE vs native split is wrong today (F-01). Correct order: if Hls injected and Hls.isSupported() → hls.js; else if audio.canPlayType('application/vnd.apple.mpegurl') → native src assignment via the existing UrlHandler-style path; else LOAD_NOT_SUPPORTED. Today the second branch doesn't exist and UrlHandler actively refuses .m3u8. This also fixes desktop Safari users who don't ship hls.js.
- Lifecycle is acceptable for prepare (fresh instance per prepare, cleanup() before creating, destroy() on dispose; rapid track changes are covered because Player.cleanup() disposes the handler which destroys hls). The defect is after prepare (F-07): the promise-scoped ERROR listener stays attached; a runtime fatal error calls reject (no-op — promise settled) and cleanup() — destroying the session mid-playback with no player-visible error. There is no recovery at all: hls.js's documented contract is startLoad() retry for fatal network errors and recoverMediaError() (once, then swapAudioCodec()+recoverMediaError()) for fatal media errors.
- Correct module shape (spec'd in T-05): handler owns an attached-session object with states attaching → buffering → ready → recovering → failed/destroyed; a persistent error listener maps non-fatal→log, fatal-network→bounded startLoad() retries with exponential backoff (respecting the load's AbortSignal), fatal-media→one recoverMediaError() cycle, else destroy + surface HLS_FATAL/HLS_NETWORK/HLS_MEDIA through a new handler→player error channel (SourceCapabilities.onError callback or an events field on PreparedSource). detachMedia() explicitly before destroy() on cleanup.
- Live vs VOD (F-08): isLive is derivable from MANIFEST_PARSED/LEVEL_LOADED details (live flag); duration must not be laundered through TimeSeconds (which zeroes Infinity). Contract: duration stays Infinity for live, plus isLive and a seekableRange capability; seek clamps to the seekable range, progress reported as 0 for live.
- EQ/visualizer integration is structurally fine (media element → source node → graph); the breakage risk is CORS (F-02) — hls.js fetches segments and feeds MSE, so the analyser path needs CORS on segment responses; same fallback policy as T-04 applies.
- Lazy loading: the DI approach (Hls constructor passed in) is the right call — better than dynamic import inside the library (bundler-agnostic, no side effects). Keep it; document a `const { default: Hls } = await import('hls.js')` recipe.

### 3. Refactoring & architecture

- SRP: Player (1035 lines) holds orchestration + context lifecycle + unlock + volume matrix + fades + normalization + quality passthrough. The worst leak is the volume/mute matrix duplicated in setVolume/setMuted/setupAudioGraph/getRestingGraphGain with instanceof HTML5Strategy checks — strategy-type sniffing in the facade. T-10 replaces it with one ownership rule. Second leak: bindStrategyEvents special-cases attachErrorHandler() for HTML5 only. Third: handler lifecycle ambiguity (F-15).
- FSM exists and is good, but transition() results are ignored (F-31) and two flows fight it (F-04, F-05). Warn-and-ignore is the right policy for a media library (throwing would crash consumers on benign races) — but ignored returns on load-critical transitions hide real bugs; log-with-context at minimum.
- Public API: the barrel exports internals (StateManager, both strategies, SourceManager, all handlers, EventEmitter). Hiding them now is breaking with little payoff; instead mark as advanced/unstable in docs (T-25) and keep. Branded types are genuinely useful at event payloads and clamping boundaries; they are formal on input positions (seek(time: number) — correctly so, ergonomics win). Only PlaybackRate's 0→1 special case is wrong (F-26).
- Error contract is coherent (single enum, fromError normalization). Gaps: swallowed HLS runtime errors (F-07), duplicate emissions in autoplay path (F-04), inferLoadErrorCode message-sniffing (acceptable as last resort; keep), and no code for autoplay-block distinct from PLAYBACK_NOT_ALLOWED (that code is actually fine — reuse it, add no new code, but stop failing load()).
- CancellationToken is sound (fresh token per load, identity check). wrap() and replace() are public conveniences — fine. The gap was threading (initialize has no signal) — T-01.

### 4. README

Rated: first screen good (one-paragraph what/why + features). Quick start good. API reference substantial but dishonest by omission: the entire loudness-normalization API, unlockAudio, freeze/unfreeze/getAudioContext, contextinterrupted/contextresumed, normalizationchange, registerHandler, waitFor options are absent; mode docs omit the 'auto' pre-load return; fade docs don't say fadeTo diverges from volume. Missing sections: Browser support & limitations (autoplay/gesture, iOS volume, CORS requirements for EQ/visualizer, HLS support matrix), install badges (npm version, bundle size via bundlephobia/size-limit), tree-shaking/ESM note. TOC skeleton (T-25): Badges → What is this (10-sec pitch) → Install → Quick start → Browser support & limitations → Choosing a strategy → Loading sources → HLS (MSE vs native matrix) → Playback → Volume/Mute → Rate & pitch → Fades → EQ → Visualization → Loudness normalization → AudioContext & autoplay unlock → Events (complete) → Errors (complete) → State machine → Cancellation → TypeScript notes → API reference → License.

### 5. Optimizations

Do: "sideEffects": false (F-25); reuse media element/source-node pair across loads (F-24); throttle public timeupdate emission from the webaudio rAF loop (F-22 — also a consistency fix); EQ setTargetAtTime (F-21 — also a quality fix); keep hls.js external (already done); future time-stretch as a subpath export so WASM/worklet never enters the base bundle (T-24). Analyser arrays are already reused — good. EQ coefficient recalculation is browser-internal per BiquadFilterNode param set — nothing to optimize there.

Avoid: replacing the 10 biquads with a custom IIR/worklet (stability + quality risk, zero measured need); closing/recreating AudioContext between tracks to "save memory" (loses unlock state, hits Safari context limits); caching AudioBufferSourceNodes (spec-impossible); code-splitting the core (single ~small bundle; splitting adds async complexity for no real gain — measure first with size-limit before any of this); suspending the context in background tabs (breaks background music playback, the primary use case).

### 6. Rate without pitch change

- HTML5: the code never touches preservesPitch, so default-true behavior currently holds by accident. Make it explicit: set preservesPitch and legacy webkitPreservesPitch (Safari <17.4) / mozPreservesPitch (old Firefox) on init and expose a toggle. Quality boundaries to document: browsers keep pitch-preservation usable roughly in 0.5×–2×; outside that, quality degrades sharply and some engines mute extremes (Chromium mutes outside [0.0625, 16] — already the clamp range; Safari historically degrades hard below 0.5). HLS goes through the media element, so the HTML5 mechanism covers HLS for free — no worklet in that path.
- Web Audio options compared:
  - SoundTouchJS (WSOLA) — small (~30 kB), AudioWorklet port exists, modest CPU, decent music quality, weaker on speech transients; MIT. Safe default.
  - Rubber Band via WASM — best quality (R3), ~0.5–1 MB WASM, higher CPU, GPL or paid commercial license — incompatible with an MIT library's default path. Only viable as user-supplied plugin.
  - Signalsmith Stretch (WASM/JS) — MIT, very good music+speech quality, ~100–150 kB, moderate CPU. Best quality/licensing balance; recommended reference plugin.
  - Hand-rolled phase vocoder worklet — smallest, but phasiness on transients; not worth building vs the above.
  - AudioWorklet support: Chrome 64+, Firefox 76+, Safari 14.1+ — fine for the plausible browser floor; Safari worklet quirks (module load timing) and Linux are exercised by the T-06 matrix.
- Architecture: stretcher node sits between strategy output and AudioGraph.input — pre-EQ so EQ bands act on true (pitch-corrected) spectrum; analyser then sees the stretched signal (correct for visualizers). Source node runs at rate 1.0; the worklet consumes input at ratio r — better quality than rate+pitch-shift-back (double resampling). Consequence: the strategy clock (_startTime/_startOffset math) is no longer the position truth; position = input-samples-consumed reported by the worklet (port messages at rAF granularity suffice). Seek must flush worklet buffers; stretcher latency (~50–100 ms) is irrelevant to 1 s fades.
- Contract decision (the main risk): do not promise a unified rate contract. Honest design: preservesPitch: boolean (default true, matching platform naming); html5 honors natively; webaudio honors only when a stretcher factory is injected (timeStretch option, DI exactly like Hls), else logs one warning and behaves as pitch-changing. Expose player.canPreservePitch: boolean (per active strategy). No new error code; no throw; no silent undetectable degradation — the capability flag makes it detectable. This mirrors the library's existing DI philosophy and keeps WASM out of the base bundle.

### 7. Tests

Current suite covers happy paths well (load types, error-code mapping, FSM flows, fades regression, HLS qualities). Missing classes: races (load-during-load with non-abort stale rejections, autoplay-block, play-resolving-after-load), buffering-state controls, live HLS, native HLS selection, handler reuse after dispose, and anything requiring a real browser (gesture unlock, real decode, real HLS, leak checks). Mocks are adequate; the fake AudioContext needs only two additions: a controllable state + statechange dispatch (for unlock/resume tests) and a decodeAudioData delay hook (for cancellation timing). Browser matrix (Playwright): Chromium — MSE HLS, webaudio decode, autoplay policy flags; Firefox — decode strictness, ramp behavior; WebKit — gesture unlock, canPlayType('application/vnd.apple.mpegurl') native-HLS selection (desktop WebKit approximates iOS for the selection logic; true iOS behavior stays a documented manual check). HLS without network: pre-generated fixture (short silence encoded to fMP4/TS segments + .m3u8, both VOD and a live-window variant) served by the test web server. Per-task test cases are embedded in Part D.

## Part D. TODOs for Opus

---

### [ ] T-01 — Gate all stale-load errors by signal identity and thread AbortSignal into strategies

Priority: P0 · Type: fix · Breaking: no · Score: M · Depends on: no · Closes findings: F-05, F-09 (abort half)

**Problem.** In Player.load() only abort-shaped errors check isCurrentLoad(); any non-abort rejection from a superseded load transitions to error and emits, corrupting the FSM for the new load (error→ready invalid). strategy.initialize() receives no signal, so cancellation surfaces as a fake media error (src="" → LOAD_NOT_SUPPORTED).

**Action steps.**
1. In Player.load() catch: check isCurrentLoad() FIRST; if stale, swallow (debug-log) and return regardless of error type. Keep existing abort branch behavior for current loads.
2. Add signal: AbortSignal to StrategyInitOptions (src/strategy/IPlaybackStrategy.ts); pass it from Player.load().
3. In Html5AudioStrategy.initialize (all three waiter paths) and WebAudioStrategy.initialize: reject with DOMException('Aborted','AbortError') on signal abort; remove element/DOM listeners on abort; check signal.aborted on entry.
4. In HTML5Strategy.dispose(), detach the init-waiter listeners before src=""/load() so disposal can't fire the waiter's error path (belt-and-suspenders alongside step 1).

**Contract.** StrategyInitOptions.signal: AbortSignal (required). Stale loads MUST produce zero error events and zero state transitions. LOAD_ABORTED semantics unchanged for the current load.

**Don't do.** Don't change the happy-path load sequence, the CancellationToken API, or handler prepare signatures.

**Acceptance criteria.**
- [ ] load B during load A's initialize: no error event, no error state, B reaches ready.
- [ ] Aborting the only load rolls back to idle silently.
- [ ] pnpm typecheck passes with the new required field (update both strategies + tests).

**Tests.** "second load during html5 initialize keeps player clean" — starts load A with a never-canplay element, loads B, asserts no error emission and state==='ready' — catches F-05. "initialize rejects with AbortError on cancel" — catches missing signal threading. "stale webaudio decode rejection is swallowed" — decode error resolving after cancellation.

**Risk.** Over-swallowing: ensure only stale (signal-mismatched) errors are suppressed; current-load errors must still emit exactly once.

---

### [ ] T-02 — Add load-generation guard to playback ops; decouple autoplay failure from load()

Priority: P0 · Type: fix · Breaking: yes (load() no longer rejects when only autoplay is blocked) · Score: M · Depends on: T-01 · Closes findings: F-04, F-06

**Problem.** Autoplay-blocked play() inside load() rejects a successful load, emits error twice, and triggers an invalid ready→error attempt. Separately, play() resolving after a newer load() mutates state for a disposed strategy.

**Action steps.**
1. Capture the current load signal in play(); after await getAudioContext() and after await strategy.play(), bail out silently if the strategy instance changed or the signal is no longer current.
2. In load() autoplay branch: call play(), catch PLAYBACK_NOT_ALLOWED, emit exactly one error event with code PLAYBACK_NOT_ALLOWED, keep state ready, and resolve load(). Non-autoplay play failures during autoplay follow the same path (state stays ready).
3. Ensure play() outside load still throws to its caller (unchanged) but emits its error exactly once (currently correct — keep).
4. Update README autoplay note in passing only if trivial; full docs land in T-25.

**Contract.** load() resolves iff the source is ready. Autoplay block ⇒ state ready + single error event (PLAYBACK_NOT_ALLOWED). No FSM warnings in this flow. No new error codes.

**Don't do.** Don't add an autoplayblocked event (code is sufficient); don't touch pause/stop guards (T-08).

**Acceptance criteria.**
- [ ] new Player({autoplay:true}) + blocked play() → load() resolves, state ready, exactly one error event.
- [ ] play() racing a new load() produces no playing transition and no error.
- [ ] Existing play-throws-to-caller test still passes.

**Tests.** "blocked autoplay resolves load with single error" — mock play rejecting NotAllowedError — catches F-04. "play resolving after new load is a no-op" — deferred strategy.play + interleaved load — catches F-06. "manual play still rejects with PLAYBACK_NOT_ALLOWED".

**Risk.** Consumers relying on load() rejection for autoplay handling — call out in changelog as behavioral fix.

---

### [ ] T-03 — Native HLS playback path for Safari/iOS

Priority: P0 · Type: fix · Breaking: no · Score: M · Depends on: no · Closes findings: F-01

**Problem.** iOS Safari has no MSE (Hls.isSupported() false) and UrlHandler rejects .m3u8, so HLS URLs throw LOAD_NOT_SUPPORTED on the one platform with native HLS support.

**Action steps.**
1. Create NativeHlsHandler in src/source/handlers/ (id 'hls-native'): canHandle = HLS-shaped source (same detection as HLSHandler) AND document.createElement('audio').canPlayType('application/vnd.apple.mpegurl') truthy; preferredStrategy() = 'html5'; prepare returns { sourceUrl: url } (plain element src path).
2. Register it in SourceManager.registerDefaultHandlers() after HLSHandler (MSE preferred when available) and before BufferHandler.
3. Cache the canPlayType probe per handler instance.
4. getCapabilities(): return { qualityLevels: [], isLive: false } — native HLS exposes no level API; quality methods absent.
5. Export from src/source/handlers/index.ts and the barrel src/index.ts.

**Contract.** Handler priority: HLSHandler (hls.js) > NativeHlsHandler > BufferHandler > BlobHandler > UrlHandler. getQualityLevels() returns [] for native HLS. Existing ISourceHandler interface unchanged.

**Don't do.** Don't implement level selection or live metadata for native HLS; don't change UrlHandler's .m3u8 rejection (it must keep deferring).

**Acceptance criteria.**
- [ ] With canPlayType mocked truthy and no Hls, an .m3u8 load reaches ready via the html5 element.
- [ ] With Hls injected and supported, HLSHandler still wins.
- [ ] With neither, LOAD_NOT_SUPPORTED (message mentioning both options).

**Tests.** "selects native HLS handler when MSE unavailable" — catches F-01. "hls.js preferred over native when both available" — catches priority inversion. "no HLS path yields LOAD_NOT_SUPPORTED with actionable message".

**Risk.** jsdom canPlayType returns '' — mock explicitly. Real-device verification lands with T-06 (WebKit selection test) + manual iOS note.

---

### [ ] T-04 — Make Web Audio routing for HTML5 a policy; fix forced crossOrigin

> **AMENDED — see amendments.md.** Step 4 (auto CORS-retry) is CANCELLED and replaced.

Priority: P0 · Type: fix · Breaking: no (default preserves routing) · Score: L · Depends on: T-01 · Closes findings: F-02, F-03

**Problem.** Every load routes the element through createMediaElementSource and (in auto mode) forces crossOrigin="anonymous". No-CORS servers fail to load; suspended contexts silence html5 playback; an AudioContext is created even for plain streaming.

**Action steps.**
1. Add PlayerOptions.webAudioRouting?: 'always' | 'never' (default 'always' — current behavior, EQ/visualizer keep working out of the box).
2. 'never': setupAudioGraph() skips source-node creation entirely; graph stays null; fades/EQ/normalization/analyser unavailable (documented); no AudioContext is created for html5 loads (audioContext getter untouched until webaudio strategy or explicit access).
3. requiresCrossOrigin in load(): true only when routing will actually happen for this load (routing 'always' and strategy html5) or strategy is webaudio — not blanket mode==='auto'.
4. ~~CORS fallback: when routing is 'always' and the element fires a media error while crossOrigin was set, retry the load once without crossOrigin and without graph routing for that source; emit one playerLogger.warn naming the consequence (EQ/fades/analyser disabled for this track). Track this per-load, reset on next load.~~ **CANCELLED — replaced by amendments.md (crossOrigin only when graph features are actually used; optional corsFallback flag, default false).**
5. getRestingGraphGain/volume paths must handle graph === null for html5 (they already fall back via _currentStrategy?.setVolume; verify).

**Contract.** webAudioRouting: 'always'|'never', default 'always'. player.graph === null whenever routing is off or fallback triggered. Fade methods already no-op on null graph — keep.

**Don't do.** Don't attempt lazy mid-playback attachment (createMediaElementSource after load can't undo CORS decisions); don't change webaudio-strategy routing. Don't insert any `await` in the path from `bindStrategyEvents` to `transition("ready")` in Player.load() — today that stretch is synchronous, which is what keeps `loading→buffering` unreachable and F-34 scoped to `ready`/`paused`; an `await` there lets a `waiting` event land in `loading` and re-open the F-34 warning. If an `await` is unavoidable (e.g. the reworked `setupAudioGraph`), add `loading→buffering` to `VALID_TRANSITIONS` in this same task.

**Acceptance criteria.**
- [ ] webAudioRouting:'never' html5 load creates no AudioContext (assert mock ctor uncalled) and graph===null.
- [ ] ~~Cross-origin URL + media error with crossOrigin set → second attempt without the attribute, load resolves, warning logged.~~ **Replaced per amendments.md: corsFallback:true → exactly one retry without crossOrigin; corsFallback absent → no retry.**
- [ ] Default behavior identical to today for CORS-enabled sources.

**Tests.** "never-routing skips AudioContext creation" — catches F-03. "CORS fallback (opt-in) retries without crossorigin and disables graph" — catches F-02. "same-origin URL never gets crossorigin attribute" — regression guard. **Added per amendments.md:** "no graph features requested → no crossOrigin attribute set".

**Risk.** Fallback retry loops — cap at exactly one retry per load; ensure retry respects the load signal (T-01).

---

### [ ] T-05 — Forward HLS runtime errors and implement recovery

Priority: P0 · Type: fix · Breaking: no · Score: L · Depends on: T-01 · Closes findings: F-07

**Problem.** After prepare resolves, the promise-scoped ERROR listener rejects a settled promise and destroys hls silently. Mid-playback fatal errors kill the stream with no event, no retry, no recovery.

**Action steps.**
1. Restructure HLSHandler.prepare: split "await readiness" (promise-scoped listeners, existing logic) from a persistent session error listener that survives resolution.
2. Add an error channel from handler to player: extend PreparedSource.metadata or (preferred) add SourceCapabilities.onRuntimeError?: (cb: (e: PlayerError) => void) => void; Player.load() subscribes after setActiveHandler and forwards through the existing error emission + transition('error') only for unrecoverable errors.
3. Recovery policy in the handler: non-fatal → playerLogger.debug; fatal NETWORK_ERROR → up to 3 hls.startLoad() retries with exponential backoff (1s/2s/4s), abort-aware via the retained load signal; fatal MEDIA_ERROR → one recoverMediaError(), then one swapAudioCodec()+recoverMediaError(), then give up; give-up → destroy + surface HLS_NETWORK/HLS_MEDIA/HLS_FATAL.
4. During recovery emit waiting semantics via the media element (it already stalls) — no new events.
5. cleanup() clears any pending backoff timers; extend HlsInstance type with startLoad(), stopLoad(), recoverMediaError(), swapAudioCodec() (all already in hls.js API).

**Contract.** Error codes unchanged (HLS_NETWORK/HLS_MEDIA/HLS_FATAL). Player emits error + transitions error only after recovery is exhausted. HlsInstance gains the four methods above.

**Don't do.** Don't retry non-fatal errors; don't add config knobs for retry counts yet (constants with comments).

**Acceptance criteria.**
- [ ] Mock fatal network error post-load → startLoad called with backoff, playback state untouched, no error event until retries exhausted.
- [ ] Exhausted retries → single error (HLS_NETWORK) + error state.
- [ ] Fatal media error → recoverMediaError called before any error emission.
- [ ] dispose() during backoff cancels timers.

**Tests.** "fatal network error triggers startLoad retries then HLS_NETWORK" — catches F-07. "fatal media error recovers via recoverMediaError without player error" — catches missing recovery. "cleanup during backoff leaves no timers" (fake timers) — catches timer leak.

**Risk.** Double error surfacing if the media element also errors during a fatal HLS failure — dedupe by ignoring element errors while an HLS session owns the element.

---

### [ ] T-06 — Test infrastructure: Playwright browser matrix + local HLS fixtures

> **AMENDED — see amendments.md.** Executes BEFORE T-03 and T-04 (right after T-02).

Priority: P1 · Type: test · Breaking: no · Score: L · Depends on: no · Closes findings: no (enables verification of T-03/T-04/T-05, F-11/F-12 class)

**Problem.** Everything browser-real (gesture unlock, real decode, real HLS, native-HLS selection, leaks) is untestable in jsdom; several P0 fixes can only be smoke-verified in real engines.

**Action steps.**
1. Add Playwright (@playwright/test) as devDependency with projects: chromium, firefox, webkit. New script test:browser; keep pnpm test jsdom-only.
2. Test app: minimal static page importing the built library (dist/index.js), served by Playwright's built-in server; build step precedes browser tests.
3. Fixtures: check in a generated 2-second tone/silence — WAV + MP3 files, plus an HLS VOD rendition (fMP4 segments + .m3u8) and a live-window playlist variant (for T-15). Document the ffmpeg one-liner used to generate them in a fixture README.
4. Chromium: launch with --autoplay-policy=no-user-gesture-required for playback tests and a second project with strict policy for unlock tests.
5. Seed suite: URL load+play+ended (all 3 engines); webaudio decode+play (all 3); hls.js playback (chromium); native-HLS handler selection (webkit, asserting handler id); gesture-unlock flow (chromium strict-policy: play rejects pre-gesture, succeeds post-click).
6. CI note only (no .github/ exists): document pnpm build && pnpm test:browser in README dev section.

**Contract.** Browser tests live in e2e/ (outside src/__tests__ vitest include). Fixture server serves CORS headers on one route and none on another (for T-04 verification).

**Don't do.** Don't migrate existing vitest suites; don't add CI pipelines.

**Acceptance criteria.**
- [ ] pnpm test:browser green on all three engines locally.
- [ ] HLS test passes with network access disabled (fixtures only).
- [ ] Strict-autoplay project demonstrates PLAYBACK_NOT_ALLOWED then post-gesture success.

**Tests.** The seed suite above IS the deliverable; each case names the finding class it guards (gesture → F-16 class, native selection → F-01, CORS routes → F-02).

**Risk.** WebKit-on-Windows flakiness for author's machine — mark webkit project as allowed-flaky in config comments, not skipped.

---

### [ ] T-07 — Restore linting (ESLint flat config)

Priority: P2 · Type: fix · Breaking: no · Score: S · Depends on: no · Closes findings: F-29

**Problem.** pnpm lint fails: ESLint 10 requires eslint.config.*; none exists. No lint gate at all.

**Action steps.**
1. Add eslint.config.js using typescript-eslint flat presets (recommended, not type-checked to keep it fast), ignore dist/, node_modules/.
2. Update the lint script (drop --ext, flat config handles it).
3. Fix or explicitly rule-disable whatever the baseline run flags; zero warnings policy off (start pragmatic: errors only).

**Contract.** pnpm lint exits 0 on main.

**Don't do.** No stylistic rule bikeshedding; no prettier introduction.

**Acceptance criteria.**
- [ ] pnpm lint runs and passes.
- [ ] A deliberate no-unused-vars violation fails it.

**Tests.** None (tooling).

**Risk.** Rule flood on first run — prefer targeted disables with comments over blanket off.

---

### [ ] T-08 — Allow pause/togglePlay during buffering

Priority: P1 · Type: fix · Breaking: no · Score: S · Depends on: no · Closes findings: F-10, F-34, F-35

**Problem.** Player.pause() guards is("playing"); in buffering it silently no-ops although buffering→paused is a valid FSM transition. togglePlay() is consequently broken while buffering. Separately (F-34, author runtime observation): the FSM lists `buffering` as reachable only from `playing`, but buffering physically occurs at the initial stall — `play()` reaches `playing` only after `await strategy.play()`, so a `waiting` event that arrives first lands in `ready` (or `paused` on resume). The unguarded `transition("buffering")` then warns AND, worse, the state never reflects buffering, so a `player.state`-bound spinner shows nothing on a frozen player at startup. Also (F-35, T-05 follow-up): the table allows `→ error` only from `loading`/`playing`/`buffering`, so a runtime error surfaced while `paused` (HLS retries exhaust after a pause / network drop) or `ready` (error after load, before play) emits an `error` event while `player.state` stays `paused`/`ready` — contradictory. All three are the same root cause: the transition table lags reality.

**Action steps.**
1. Change pause() guard to _stateManager.isActive (playing|buffering).
2. togglePlay(): base decision on _stateManager.isActive instead of isPlaying (strategy truth diverges while stalled).
3. Audit stop() for the same class (it has no guard — confirm buffering→ready valid; it is).
4. (F-34) Expand `VALID_TRANSITIONS`: add `buffering` to the `ready` and `paused` target lists so the initial-stall and resume-stall cases are legal. Keep the `waiting` handler emitting `transition("buffering")` unconditionally — do NOT guard it, or the buffering state is lost at startup (the whole point). Return paths from `buffering` already exist (`playing`/`paused`/`ready`/`error`/`idle`/`disposed`), so no stuck state. `loading→buffering` is intentionally NOT added: the bind→ready sequence is synchronous, so no `waiting` is delivered while `loading`.
5. (F-35) Expand `VALID_TRANSITIONS`: add `error` to the `ready` and `paused` target lists so a runtime error surfaced in those states transitions correctly. Do NOT change `handleRuntimeError` (it must still emit once); the fix is the table, so state and event agree. `error`'s own exits (`loading`/`idle`/`disposed`) already allow recovery via a fresh load.

**Contract.** FSM gains `ready→buffering`, `paused→buffering`, `ready→error`, `paused→error`. `buffering` reachable from `{playing, ready, paused}`; `error` reachable from `{loading, playing, buffering, ready, paused}`. `player.state` reflects buffering at the initial stall/resume and error whenever an error event is emitted. pause() from buffering → paused. The `waiting`/`buffered`/`error` public events are unchanged.

**Don't do.** Don't guard/suppress the `waiting` emitter (drops the startup buffering state); don't change `handleRuntimeError`'s single emit; don't touch strategy internals or the strategy's own `waiting`/`playing` emission; don't change the `playing` handler's `is("buffering")` guard; don't add `loading→buffering` (not reachable) or any new `buffering→`/`error→` exits beyond those already present.

**Acceptance criteria.**
- [ ] waiting → pause() → state paused, no FSM warning.
- [ ] togglePlay() during buffering pauses.
- [ ] (F-34) play() on a stalling source: `waiting` before `playing` → `player.state === "buffering"` (not `ready`), no "Invalid state transition" warning; when data arrives → `playing`.
- [ ] (F-34) resume from `paused` with a stall → `buffering` then `playing`, no warning.
- [ ] (F-35) runtime error while `paused` → `player.state === "error"` and one `error` event, no FSM warning.
- [ ] (F-35) runtime error while `ready` (after load, before play) → `player.state === "error"` and one `error` event.

**Tests.** "pause during buffering transitions to paused" — catches F-10. "togglePlay during buffering pauses instead of double-playing" — catches the isPlaying divergence. "waiting after play() from ready enters buffering without warning" — catches F-34 (state + no-warn). "waiting after resume from paused enters buffering" — catches the resume path. "runtime HLS error while paused transitions to error" — catches F-35 (add to hls.test.ts; all four existing T-05 recovery tests call play(), so this paused path is uncovered). Extend test-utils so the mock element can emit `waiting` before `playing` on play() (deferred/stall hook).

**Risk.** A genuinely stuck stream stays in `buffering` (correct) with exits via pause/stop/error/load. HTML5 element may emit playing after pause if the stall resolves mid-call — verify the playing handler's is("buffering") guard prevents a bogus transition (it does; keep a regression test). No existing test encodes `ready↛buffering`/`paused↛error` as invalid (the invalid-transition unit test uses `idle→playing`), so the table changes are safe.

---

### [ ] T-09 — Unify HTML5 readiness waiting: single helper with timeout + signal

Priority: P1 · Type: refactor · Breaking: no · Score: S · Depends on: T-01 · Closes findings: F-09

**Problem.** Three near-duplicate promise waiters in Html5AudioStrategy.initialize; the sourceUrl path (the most common) has no timeout, so a stalled network hangs load() forever.

**Action steps.**
1. Extract one private waiter: waits loadedmetadata|canplay vs error, with timeout (default 30 s, constant) and the T-01 signal; always cleans listeners + timer.
2. Use it in all three initialize branches; the sourceUrl branch gains the timeout.
3. Timeout rejection → PlayerError(LOAD_NETWORK) with a message naming the timeout, not a bare Error.

**Contract.** Timeout error surfaces as LOAD_NETWORK. Waiter resolves on the earliest readiness event.

**Don't do.** Don't make the timeout configurable yet; don't change readiness thresholds (readyState >= 1 fast-paths stay). Don't insert any `await` in the path from `bindStrategyEvents` to `transition("ready")` in Player.load() — that stretch is synchronous today, which keeps `loading→buffering` unreachable and F-34 scoped to `ready`/`paused`; an `await` there lets a `waiting` event land in `loading` and re-open the F-34 warning. The new waiter belongs inside `strategy.initialize()` (before `bindStrategyEvents`), so this holds; if any `await` does land in that path, add `loading→buffering` to `VALID_TRANSITIONS` in this same task.

**Acceptance criteria.**
- [ ] A source that never fires canplay rejects load() with LOAD_NETWORK after the timeout (fake timers).
- [ ] All three paths share one implementation (no duplicated listener bookkeeping).

**Tests.** "url load times out with LOAD_NETWORK" — catches F-09. "timeout cleans up listeners and timer" — catches leak on the new path.

**Risk.** Pre-attached HLS media path relies on the 30 s behavior — keep identical constant.

---

### [ ] T-10 — Split volume and fade gains in AudioGraph; single volume-ownership rule

Priority: P1 · Type: refactor · Breaking: yes (fadeTo becomes a fade-multiplier on top of volume; AudioGraph.setVolume semantics shift) · Score: L · Depends on: T-04 · Closes findings: F-13, F-11; documents F-12 (risk accepted)

**Problem.** Fade and volume share _outputGain: fadeTo changes audible level while player.volume reports stale state; the instanceof HTML5Strategy volume matrix is duplicated in four places; iOS ignores element.volume, silently killing html5 volume.

**Action steps.**
1. AudioGraph: add a dedicated _volumeGain node after _outputGain (chain: input → normalization → EQ → analyser → fadeGain(=_outputGain) → volumeGain → destination-connectable output). setVolume/setVolumeImmediate drive _volumeGain; fadeTo/cancelFade drive fadeGain only. fadeTo range stays 0..1 as a multiplier.
2. Player: when the graph is routed (any strategy), volume/mute apply to graph volumeGain and the strategy's own volume is pinned to 1 / unmuted — including html5 (fixes iOS volume when routed). When no graph (routing 'never' or CORS fallback), volume applies to the strategy (element), iOS caveat documented.
3. Delete getRestingGraphGain and the instanceof branches in setVolume/setMuted/setupAudioGraph; replace with one private applyVolumeAndMute() using the rule above.
4. fadeIn/fadeOut/fadeOutAndPause/Stop: target fade multiplier 1/0; remove the post-pause fadeTo(resting, 0) restore hack — fadeGain reset to 1 after pause/stop instead.
5. Document F-12 (throttled-timer late pause is inaudible because fadeGain is already 0) as accepted behavior in code comment + README note (T-25).

**Contract.** player.volume is always the authoritative user volume; fades never change it. AudioGraph.fadeTo(multiplier, sec, from?). isFading semantics unchanged. Effective output = volume × fade × normalization.

**Don't do.** Don't touch normalization gain or EQ chain order; don't attempt background-timer workarounds.

**Acceptance criteria.**
- [ ] After fadeTo(0.3), player.volume unchanged and setVolume(x) behaves independently of fade state.
- [ ] Repeated fadeOut/fadeIn cycles land at exactly volume×1 (existing regression test adapted, not deleted).
- [ ] html5 with routed graph: element volume stays 1, graph volumeGain reflects setVolume.
- [ ] Un-routed html5: element volume used.

**Tests.** "fade does not corrupt player.volume" — catches F-13. "html5 volume applied via graph when routed" — catches F-11 (unit-level; WebKit e2e sanity via T-06). "fadeOutAndPause resets fade gain without touching volume" — catches the restore-hack regression.

**Risk.** Existing fade regression tests encode the old single-gain behavior — update deliberately, preserving the bugs they guard (stale AudioParam finalization, cancel-restore).

---

### [ ] T-11 — Harden unlockAudio and context auto-resume

Priority: P1 · Type: fix · Breaking: no · Score: S · Depends on: no · Closes findings: F-16, F-17

**Problem.** unlockAudio hangs forever on a non-running context (onended never fires) and its latch wedges; auto-resume (void this.unfreezeAudioContext()) can produce unhandled rejections with no retry.

**Action steps.**
1. unlockAudio: resolve when ctx.state === 'running' (listen statechange) OR the silent buffer ends; add a timeout (~2 s) that rejects with PLAYBACK_NOT_ALLOWED; reset _isAudioUnlocking in finally; reset _isAudioUnlocked whenever _ctx is recreated (in getAudioContext's closed-context branch and after dispose).
2. Auto-resume in onstatechange: append .catch(err => playerLogger.debug(...)); no retry loop (next gesture-driven play()/getAudioContext() is the retry).
3. Disconnect the placeholder source in the timeout path.

**Contract.** unlockAudio(): Promise<void> always settles; rejection code PLAYBACK_NOT_ALLOWED. Repeat calls after failure retry (latch released).

**Don't do.** Don't auto-call unlockAudio from play(); don't add gesture listeners globally.

**Acceptance criteria.**
- [ ] Suspended mock context that never runs → unlockAudio rejects within timeout; a later call retries.
- [ ] Running context → resolves.
- [ ] Rejected resume() in the interrupted→suspended path produces no unhandled rejection (vitest process.on guard).

**Tests.** "unlockAudio rejects on stuck-suspended context and releases latch" — catches F-16. "auto-resume rejection is contained" — catches F-17. "unlock state resets after context recreation" — catches the stale _isAudioUnlocked latch.

**Risk.** Mock AudioContext needs a controllable state + statechange dispatch — extend test-utils.ts (also needed by T-06 groundwork).

---

### [ ] T-12 — Clear loudness metadata on load

Priority: P1 · Type: fix · Breaking: no (bugfix; opt-out added) · Score: S · Depends on: no · Closes findings: F-18

**Problem.** _loudnessMetadata survives cleanup(), so load() re-applies the previous track's normalization gain to the new track.

**Action steps.**
1. In Player.load() (after cleanup, before recomputeNormalization): reset _loudnessMetadata = null unless a new option loudnessNormalization.retainMetadataAcrossLoads (default false) is set.
2. Emit normalizationchange reflecting the reset (existing recomputeNormalization path already does when metadata is null — verify ordering).
3. Document the per-track workflow: load() → setLoudnessMetadata(meta).

**Contract.** New optional field LoudnessNormalizationOptions.retainMetadataAcrossLoads?: boolean (default false). Default: every load starts at 0 dB normalization until metadata is set.

**Don't do.** Don't clear on dispose differently; don't touch gain math.

**Acceptance criteria.**
- [ ] Track A with +6 dB metadata, then load(B) → applied gain 0 dB and normalizationchange{enabled:false} fired.
- [ ] With retain flag, old behavior.

**Tests.** "normalization gain resets on new load" — catches F-18. "retain flag preserves metadata" — guards the opt-out.

**Risk.** Apps that relied on sticky metadata — the flag is the escape hatch; changelog note.

---

### [ ] T-13 — Explicit mode wins over soft handler preference

Priority: P1 · Type: fix · Breaking: no (behavioral bugfix) · Score: S · Depends on: no · Closes findings: F-14

**Problem.** handler.preferredStrategy() hard-overrides even an explicit mode:'html5'|'webaudio'. Only HLS truly requires html5; BufferHandler's webaudio preference should not veto a user's explicit choice (blob-URL html5 works).

**Action steps.**
1. Add optional ISourceHandler.requiredStrategy?(): 'html5' | 'webaudio' | undefined. HLSHandler (and T-03's NativeHlsHandler) return 'html5'.
2. Player.load() resolution: explicit mode → use it, overridden only by requiredStrategy() (warn when overriding, as today). mode:'auto' → recommendStrategy() (which already consults preferredStrategy).
3. Keep preferredStrategy() as the auto-mode hint; document both on the interface.

**Contract.** requiredStrategy optional on ISourceHandler (non-breaking addition). Explicit mode + buffer source → honored (blob-URL path). HLS + mode:'webaudio' → html5 with warning (unchanged outcome).

**Don't do.** Don't change recommendStrategy heuristics; don't remove preferredStrategy.

**Acceptance criteria.**
- [ ] new Player({mode:'html5'}).load({data: arrayBuffer}) uses HTML5Strategy via object URL.
- [ ] HLS under mode:'webaudio' still forces html5 with a warning.
- [ ] Auto mode behavior byte-identical to today.

**Tests.** "explicit html5 mode plays ArrayBuffer via blob URL" — catches F-14. "HLS still overrides explicit webaudio" — guards the required-vs-preferred split.

**Risk.** Custom handlers relying on preferred-as-hard-override — interface docs must state the new semantics.

---

### [ ] T-14 — Fix handler lifecycle: stop disposing singletons per load

Priority: P1 · Type: refactor · Breaking: no · Score: S · Depends on: T-05 · Closes findings: F-15

**Problem.** Player.cleanup() calls dispose() on handlers that live in SourceManager._handlers and are reused next load. Works only because disposes are idempotent; it's a contract landmine (any handler holding real per-instance state breaks).

**Action steps.**
1. Rename per-load teardown: give ISourceHandler an explicit reset(): void (release per-load session: hls instance, timers) distinct from dispose() (terminal).
2. Player.cleanup() calls _currentHandler?.reset(); SourceManager.dispose() remains the only dispose() caller.
3. HLSHandler: reset() = current cleanup(); dispose() = reset + null the _Hls ref. Other handlers: reset() noop.
4. Document lifecycle on ISourceHandler: constructed once, prepare per load, reset between loads, dispose once.

**Contract.** ISourceHandler gains reset() — optional-with-fallback (`handler.reset?.()`) to keep Breaking: no. dispose() is terminal and only invoked by SourceManager.dispose().

**Don't do.** Don't move to per-load handler instantiation (bigger churn, no payoff).

**Acceptance criteria.**
- [ ] Two sequential HLS loads on one player reuse the handler and each gets a fresh hls instance.
- [ ] After player.dispose(), SourceManager handlers disposed exactly once.

**Tests.** "handler reused across loads with fresh session" — catches F-15. "dispose is terminal and single" — guards double-dispose regressions. Custom-handler mock verifying reset/dispose call counts.

**Risk.** External custom handlers (via registerHandler) must add reset — choose optional-with-fallback (`handler.reset?.()`) to keep Breaking: no; mark in changelog.

---

### [ ] T-15 — Live HLS support: isLive, Infinity duration, seekable range

Priority: P1 · Type: fix · Breaking: no (additive) · Score: M · Depends on: T-05, T-06 (live fixture) · Closes findings: F-08

**Problem.** isLive hardcoded false; TimeSeconds(Infinity) → 0 zeroes live durations; seek clamps to 0; progress meaningless for live.

**Action steps.**
1. HLSHandler: derive live flag from LEVEL_LOADED/manifest details; store on the session; getCapabilities().isLive returns it. NativeHlsHandler: isLive = duration === Infinity after metadata.
2. TimeSeconds: permit Infinity (change the guard to reject only negatives/NaN). Audit consumers: Player.seek clamp, timeupdate.progress division, loadedmetadata payload.
3. Player: add get isLive(): boolean (from active capabilities, default false). seek on live: clamp to element.seekable range when available; no-op with debug log when the range is empty. progress = 0 when duration === Infinity.
4. Add SourceCapabilities.getSeekableRange?(): { start: number; end: number } | null.

**Contract.** duration is Infinity for live. player.isLive: boolean. timeupdate.progress === 0 for live. getSeekableRange optional capability.

**Don't do.** Don't implement live-edge tracking/latency controls; don't emit new events.

**Acceptance criteria.**
- [ ] Live fixture: isLive===true, duration===Infinity, progress 0, seek within seekable works, seek beyond clamps.
- [ ] VOD unchanged (finite duration, progress correct).

**Tests.** "live manifest reports isLive and Infinity duration" — catches F-08. "seek on live clamps to seekable range" — catches the clamp-to-0 bug. "TimeSeconds(Infinity) preserved" — unit, catches the brand launder. e2e (T-06): live playlist plays ≥1 segment in chromium.

**Risk.** Infinity leaking into UI math of consumers — README must show the isLive guard pattern (T-25).

---

### [ ] T-16 — hlsConfig passthrough and quality API polish

Priority: P2 · Type: fix · Breaking: no · Score: S · Depends on: T-05 · Closes findings: F-19, F-20

**Problem.** Only 5 hlsConfig keys forwarded; startFragPrefetch typed but dead; arbitrary hls.js options impossible. setQuality(-1) never emits qualitychange; index unvalidated.

**Action steps.**
1. HLSHandler.prepare: build config as defaults-merged-with-user Partial<HLSConfig> & Record<string, unknown> and pass the whole merged object to new Hls(...). Widen PlayerOptions.hlsConfig type to Partial<HLSConfig> & Record<string, unknown>.
2. Forward startFragPrefetch (now automatic via passthrough).
3. Player.setQuality: validate level === -1 || levels[level]; emit qualitychange only on valid explicit levels, return boolean from setQuality for feedback.

**Contract.** setQuality(level: number): boolean. Unknown hls.js keys pass through untouched.

**Don't do.** Don't re-type all of hls.js config; don't validate hls.js option values.

**Acceptance criteria.**
- [ ] hlsConfig: { lowLatencyMode: true } reaches the Hls constructor.
- [ ] setQuality(99) returns false, no emit, no crash.
- [ ] setQuality(-1) sets currentLevel=-1, returns true.

**Tests.** "arbitrary hls config keys forwarded" — catches F-19. "setQuality validates index" — catches out-of-range writes to hls.

**Risk.** Users passing config that conflicts with library assumptions (autoStartLoad:false) — document that library defaults are overridable at own risk.

---

### [ ] T-17 — Smooth EQ parameter updates

Priority: P2 · Type: perf/quality · Breaking: no · Score: S · Depends on: no · Closes findings: F-21

**Problem.** setEQBand uses setValueAtTime → stepwise gain changes cause zipper noise on slider drags; setEQEnabled already uses setTargetAtTime(…, 0.015).

**Action steps.**
1. setEQBand/resetEQ: switch to setTargetAtTime(gain, now, 0.015) matching setEQEnabled.
2. Note in doc comment why (zipper noise).

**Contract.** getEQBand still returns the target from _bands (unchanged).

**Don't do.** Don't smooth frequency/Q (unset paths); don't make the time-constant configurable.

**Acceptance criteria.**
- [ ] Mock AudioParam records setTargetAtTime calls for band updates.
- [ ] Existing EQ tests pass with assertion updates.

**Tests.** "setEQBand uses smoothed param update" — catches regression to stepped updates.

**Risk.** None material.

---

### [ ] T-18 — Seek/timeupdate parity between strategies

Priority: P2 · Type: fix · Breaking: no · Score: M · Depends on: T-01 · Closes findings: F-22, F-28

**Problem.** WebAudio seek internally pause+plays → spurious pause/play events html5 never emits; seeked is emitted synchronously though html5 seeks async; webaudio timeupdate is 60 Hz rAF (frozen in background tabs) vs native ~4 Hz.

**Action steps.**
1. WebAudioStrategy.seek: suppress pause/play emissions during internal restart (private _seeking flag around the pause/play pair).
2. Player.seek: for html5, emit seeked from the element's native seeked event (add to strategy event map + bindStrategyEvents); webaudio keeps synchronous emission (it is synchronous).
3. Webaudio timeupdate: replace rAF-driven public emission with an interval of 250 ms (aligned with typical native cadence), implemented with setInterval so background tabs still update (throttled to ≥1 s — acceptable, better than frozen). Keep rAF out entirely; getCurrentTime() stays on-demand.
4. Player.seek when duration unknown (0/NaN, not live): skip the upper clamp instead of clamping to 0 (lower clamp at 0 remains).

**Contract.** PlaybackStrategyEvents gains seeked: TimeSeconds. seeking still synchronous. Timeupdate cadence documented (~4/s foreground).

**Don't do.** Don't add a cadence option; don't change html5 native timeupdate handling.

**Acceptance criteria.**
- [ ] Webaudio seek fires exactly seeking+seeked, zero pause/play.
- [ ] html5 seeked fires after the element reports it.
- [ ] Webaudio timeupdate ticks with fake timers advancing 250 ms, without rAF.

**Tests.** "webaudio seek emits no pause/play flicker" — catches F-22. "html5 seeked follows native event" — catches the premature-seeked lie. "seek before metadata is not clamped to zero" — catches F-28.

**Risk.** Consumers timing UI off the 60 Hz feed — changelog note; currentTime getter remains real-time for animation loops (document the pattern).

---

### [ ] T-19 — Injectable / shared AudioContext

Priority: P2 · Type: feature · Breaking: no · Score: S · Depends on: T-11 · Closes findings: F-23

**Problem.** One context per Player; multi-player apps hit iOS context limits and can't share a context/unlock state.

**Action steps.**
1. PlayerOptions.audioContext?: AudioContext. When provided: audioContext getter returns it (still installing the statechange handler, chaining any pre-existing one is out of scope — document that the player takes over onstatechange); dispose() MUST NOT close an injected context (track _ownsContext).
2. latencyHint ignored with a debug log when a context is injected.
3. Closed injected context: throw PlayerError(PLAYBACK_FAILED) on first use with a clear message (don't silently recreate someone else's context).

**Contract.** PlayerOptions.audioContext?: AudioContext; ownership rule: close only what you created.

**Don't do.** Don't build a context-sharing registry; don't multiplex onstatechange.

**Acceptance criteria.**
- [ ] Two players sharing one mock context both play; dispose() of one leaves the context open.
- [ ] Owned-context dispose still closes it.

**Tests.** "injected context is not closed on dispose" — catches ownership violation. "owned context closed on dispose" — regression guard.

**Risk.** onstatechange takeover clobbers app handlers — documented limitation.

---

### [ ] T-20 — Reuse the HTMLAudioElement/MediaElementSourceNode pair across loads

> **AMENDED — see amendments.md: DEFERRED, excluded from this pass. Do not implement.**

Priority: P2 · Type: perf · Breaking: no · Score: M · Depends on: T-04, T-14 · Closes findings: F-24

**Problem.** Every load constructs a new Audio() and (when routed) a new MediaElementAudioSourceNode; long playlist sessions accumulate elements/nodes (Chrome historically retains MediaElementSource-attached elements aggressively).

*(Original spec retained for the future iteration; see the audit history. Deferred per amendments.md — the shared element captured in turn by HTML5 strategy, hls.js, and native HLS is a residual-state bug magnet; revisit after T-03/T-05 have settled.)*

---

### [ ] T-21 — Packaging: sideEffects flag + size tracking

Priority: P2 · Type: perf · Breaking: no · Score: S · Depends on: no · Closes findings: F-25

**Problem.** No "sideEffects": false → bundlers keep the whole barrel; no size regression guard.

**Action steps.**
1. Verify no module-scope side effects beyond the playerLogger singleton creation (pure assignment — safe); add "sideEffects": false to package.json.
2. Add size-limit (or pnpm build + a documented gzip -c dist/index.js | wc -c check) with a budget in package.json; record the current number in README badges section (T-25 consumes it).

**Contract.** "sideEffects": false. Size budget documented.

**Don't do.** No code splitting, no subpath entry points yet (revisit with T-24).

**Acceptance criteria.**
- [ ] Build passes; a consumer importing only PlayerError tree-shakes Player out (verifiable with a quick esbuild metafile check, documented in the PR).
- [ ] Size check runs via a script.

**Tests.** None beyond the build check (tooling).

**Risk.** A future module gaining real side effects silently breaks consumers — comment in package.json pointing at the constraint.

---

### [ ] T-22 — API hygiene batch

> **AMENDED — see amendments.md: SPLIT into T-22a (non-breaking) and T-22b (breaking).**

**T-22a** (non-breaking) · Priority: P2 · Type: fix · Score: S · Depends on: no · Closes findings: F-26, F-31, F-33
1. PlaybackRate: non-finite → 1 (unchanged); any finite value clamps into [0.0625, 16] including 0 and negatives → 0.0625. Update doc comment.
2. Replace console.debug in HLSHandler with playerLogger.debug.
3. In Player, capture transition() returns at the four load-critical sites (loading, ready, playing, error): keep StateManager warn, add Player debug context with the calling operation name when false.

**T-22b** (breaking, type-level) · Priority: P2 · Type: fix · Score: S · Depends on: no · Closes findings: F-27 · Ships in the major release with T-02/T-10 (see T-26)
1. Remove ReadableStream<Uint8Array> from AudioSource.data union.

**Contract.** PlaybackRate = pure clamp into [0.0625, 16] for finite inputs. AudioSource.data: File | Blob | ArrayBuffer | Uint8Array (after T-22b).

**Don't do.** Don't implement streaming/MSE ingestion; don't throw on failed transitions.

**Acceptance criteria.**
- [ ] createPlaybackRate(0) === 0.0625; createPlaybackRate(-1) === 0.0625; createPlaybackRate(NaN) === 1.
- [ ] (T-22b) typecheck fails for load({data: stream}) in a consumer-style test.
- [ ] No raw console.* outside Logger.ts (grep-verified).

**Tests.** "PlaybackRate clamps consistently" — catches F-26. Type-level test (@ts-expect-error) for ReadableStream — catches F-27 regression.

**Risk.** Someone passed 0 expecting 1× — edge case; changelog line.

---

### [ ] T-23 — Explicit preservesPitch support in the HTML5 strategy

Priority: P1 · Type: feature · Breaking: no · Score: S · Depends on: no · Closes findings: F-32 (html5 half)

**Problem.** Pitch preservation currently works by browser default only; nothing sets preservesPitch, no vendor fallbacks, no toggle, no documentation of quality boundaries. HLS (media-element path) inherits this for free once fixed.

**Action steps.**
1. PlayerOptions.preservesPitch?: boolean (default true) + Player.setPreservesPitch(v: boolean) + get preservesPitch(): boolean (stored intent).
2. HTML5Strategy: on initialize and on toggle, set preservesPitch, and when absent fall back to webkitPreservesPitch (Safari <17.4) / mozPreservesPitch (legacy Firefox) via feature detection ('preservesPitch' in el).
3. WebAudioStrategy: store the intent; log one warning when preservesPitch===true and rate ≠ 1 is applied without a stretcher (full support in T-24).
4. Add get canPreservePitch(): boolean on Player: html5 → feature-detected true; webaudio → false until T-24.
5. Document quality boundaries (usable ~0.5×–2×; extremes degrade/mute) in doc comments; README lands in T-25.

**Contract.** preservesPitch default true. canPreservePitch reflects the active strategy. ratechange event unchanged.

**Don't do.** No time-stretch DSP; no rate-range changes.

**Acceptance criteria.**
- [ ] html5 init sets preservesPitch=true (or vendor equivalent) on the element.
- [ ] setPreservesPitch(false) + rate 1.5 → element preservesPitch===false.
- [ ] canPreservePitch false in webaudio mode.

**Tests.** "initialize sets preservesPitch and vendor fallback" — catches silent vendor gaps. "toggle propagates to element" — catches stale-element state. "webaudio warns once when pitch preservation requested" — catches silent divergence (the F-32 core risk).

**Risk.** jsdom lacks preservesPitch — extend MockAudioElement.

---

### [ ] T-24 — Optional time-stretch plugin API for the WebAudio strategy

Priority: P2 · Type: feature · Breaking: no (additive; plugin optional) · Score: L · Depends on: T-23, T-18, T-10 · Closes findings: F-32 (webaudio half)

**Problem.** WebAudio rate always shifts pitch. Time-stretch must be pluggable without pulling WASM/worklets into the base bundle, and must not break currentTime/seek/fade contracts.

**Action steps.**
1. Define ITimeStretchNode interface in src/strategy/: creates/wraps an AudioWorklet-backed node; members (names binding, bodies not): node: AudioNode, setRate(rate: number): void, getInputPosition(): number, flush(): void, dispose(): void, plus an async factory type TimeStretchFactory = (ctx: AudioContext) => Promise<ITimeStretchNode>.
2. PlayerOptions.timeStretch?: TimeStretchFactory (DI, exactly the Hls pattern; never imported by the library).
3. WebAudioStrategy: when factory present AND preservesPitch intent true — source plays at rate 1.0 into stretcher.node, connectToGraph returns the stretcher output (pre-AudioGraph.input, hence pre-EQ/analyser — EQ acts on pitch-true signal, visualizer sees final audio); getCurrentTime() truth becomes getInputPosition()-based; seek calls flush(); rate changes call setRate (existing _startTime math bypassed in stretcher mode).
4. Without factory or with preservesPitch:false: current resampling behavior (documented, canPreservePitch===false).
5. Player.canPreservePitch (T-23) returns true in webaudio mode iff factory present.
6. Recommend + document (README, T-25) reference plugins with license notes: SoundTouchJS worklet (MIT, light), Signalsmith Stretch WASM (MIT, best quality/weight balance); explicitly warn that Rubber Band WASM is GPL/commercial.
7. ~~Optionally add a lyra-audio/timestretch-soundtouch subpath~~ **CANCELLED per amendments.md (Q6): interface + wiring only, no second artifact.**

**Contract.** ITimeStretchNode, TimeStretchFactory exported types. Position source of truth in stretcher mode = stretcher input position. Fades/EQ unchanged (stretcher sits before AudioGraph.input). No new error codes; absence of plugin = documented pitch-changing behavior + capability flag false.

**Don't do.** No bundled WASM/worklet code; no attempt at rate+pitch-shift-back architecture (double resampling); no HLS/html5 involvement (covered natively by T-23).

**Acceptance criteria.**
- [ ] With a mock stretcher factory: rate 1.5 keeps AudioBufferSourceNode.playbackRate === 1 and calls setRate(1.5).
- [ ] currentTime follows mock getInputPosition.
- [ ] Seek triggers flush.
- [ ] Without factory: behavior byte-identical to today.
- [ ] Bundle size unchanged (T-21 check).

**Tests.** "stretcher mode drives rate via plugin, source stays 1.0" — catches double-rate application (audible chipmunk+slow bug). "currentTime derives from stretcher position" — catches timing drift. "seek flushes stretcher" — catches stale-buffer bleed after seek. "no plugin → resample path untouched" — regression guard.

**Risk.** Position reporting granularity (worklet port messages) can make timeupdate jittery — smooth in the strategy by interpolating between reports against ctx.currentTime.

---

### [ ] T-25 — README overhaul

Priority: P1 · Type: docs · Breaking: no · Score: M · Depends on: T-02, T-03, T-04, T-10, T-15, T-23 (documents their contracts) · Closes findings: F-30; documents F-11, F-12 caveats

**Problem.** README omits the normalization API, context management (unlockAudio, freeze/resume, contextinterrupted/resumed), normalizationchange, browser limitations, bundle size, and misstates mode's pre-load value; fade-vs-volume semantics undocumented.

**Action steps.**
1. Restructure to this TOC: Badges (npm, size, license) → What is lyra-audio (≤3 lines) → Install → Quick start → Browser support & limitations (autoplay/gesture unlock incl. unlockAudio, iOS element-volume caveat when un-routed, CORS requirements for EQ/analyser + fallback behavior, HLS matrix: hls.js vs native vs unsupported, background-tab fade timing note) → Choosing a strategy → Loading sources → HLS (incl. live: isLive, Infinity duration pattern) → Playback control → Rate & pitch (preservesPitch, canPreservePitch, quality range 0.5–2×, time-stretch plugin pointer) → Volume & mute → Fades (fade is a multiplier; volume unaffected) → EQ → Visualization → Loudness normalization (full section: options, metadata workflow, events) → AudioContext management → Events (complete list incl. contextinterrupted/resumed, normalizationchange) → Errors (complete code table incl. autoplay semantics from T-02) → State machine → Cancellation → TypeScript notes → API reference (audit every row against src/index.ts; add missing Player members; mark StateManager/strategies/handlers exports as advanced) → Development (test commands incl. test:browser) → License.
2. Fix factual errors: mode returns 'auto' before load; seeked timing per T-18; load() autoplay behavior per T-02.
3. Add the size number from T-21. Add Migration section pointer (T-26).

**Contract.** Every public export in src/index.ts appears in the reference or is explicitly labeled advanced/internal-ish.

**Don't do.** Don't write marketing prose; don't document unreleased behavior — this task lands after its dependencies.

**Acceptance criteria.**
- [ ] Diff of exported symbols vs reference table = ∅ unexplained.
- [ ] Every event in PlayerEventMap documented.
- [ ] Every PlayerErrorCode documented.
- [ ] Browser-limitations section covers the five caveats listed in step 1.

**Tests.** None (docs); optional: a script asserting every PlayerEventMap key appears in README (nice-to-have, skip if noisy).

**Risk.** Drift — mitigated by the export-vs-table acceptance check being repeatable.

---

### Finding coverage check

F-01→T-03, F-02/F-03→T-04, F-04/F-06→T-02, F-05/F-09→T-01/T-09, F-07→T-05, F-08→T-15, F-10→T-08, F-11/F-12/F-13→T-10 (F-12 timer throttling itself: risk accepted — the ramp is audio-thread-scheduled so the late pause is inaudible; a worklet-based completion clock is not worth the complexity), F-14→T-13, F-15→T-14, F-16/F-17→T-11, F-18→T-12, F-19/F-20→T-16, F-21→T-17, F-22/F-28→T-18, F-23→T-19, F-24→T-20 (deferred per amendments.md — F-24 risk accepted for this pass), F-25→T-21, F-26/F-31/F-33→T-22a, F-27→T-22b, F-29→T-07, F-30→T-25, F-32→T-23/T-24, F-34/F-35→T-08 (author observations, FSM table lags reality; folded into T-08).

## Part E. Open Questions

> **All six answered in amendments.md — no longer blocking.**

1. Is always-routing HTML5 through Web Audio a product decision? (EQ/visualizer "just work" vs CORS/silence costs.) Blocks the default choice in T-04. Assumption adopted: keep 'always' as default, add 'never' + CORS fallback. If the author prefers un-routed-by-default, T-04's default flips and T-10's html5 volume rule inverts.
2. Is sticky loudness metadata across tracks intentional (e.g., album-level metadata)? Blocks T-12's default. Assumption: clear on load, opt-out flag.
3. Browser support floor (min Safari/Firefox versions)? Affects T-23 vendor-prefix effort and T-24 worklet baseline. Assumption: Safari 14.1+, evergreen Chrome/Firefox.
4. Is live HLS an intended use case (forStreaming suggests yes, isLive:false suggests no)? Blocks T-15 scope. Assumption: yes, VOD+live both supported.
5. May the exported-internals surface (StateManager, strategies, handlers, SourceManager) be narrowed in a future major? No task blocked (T-25 documents them as advanced); affects long-term API direction only.
6. Is a second published artifact (e.g. lyra-audio/timestretch-soundtouch subpath or sibling package) acceptable? Blocks the optional step 7 of T-24. Assumption: interface-only in core; reference plugin lives outside this repo. Also confirm: Rubber Band's GPL licensing is unacceptable for the default recommendation (assumed yes; MIT alternatives recommended).

Not found, stated plainly: no CI, no CHANGELOG, no prior issue history in the repo to cross-check whether any of the above behaviors were deliberate — all "intentional?" questions above stem from that absence.
