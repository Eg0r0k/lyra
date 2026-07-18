# Amendments to the Fable Audit

> **This file OVERRIDES `fable-audit.md` wherever they conflict.**
> Decisions made after reviewing the audit report. Read both files before
> starting any task. Track progress in `progress.md`.

## Answers to Open Questions (Part E)

| Q | Decision |
|---|----------|
| Q1 | `webAudioRouting` defaults to `'always'` — EQ/visualizer must work out of the box. BUT `crossOrigin` is set **only when graph features are actually needed** for the load (see T-04 amendment below), not blanket for the mode. |
| Q2 | Loudness metadata is **cleared on every `load()`**; `retainMetadataAcrossLoads` opt-out flag as spec'd in T-12. Sticky behavior was a bug. |
| Q3 | Browser floor: **Safari 15+**, evergreen Chrome/Firefox. Keep the `webkitPreservesPitch` / `mozPreservesPitch` vendor fallbacks anyway — they cost three lines of feature detection. |
| Q4 | **Live HLS is supported.** T-15 in full scope. `forStreaming` already promises it; hardcoded `isLive: false` was an omission, not a decision. |
| Q5 | **Do not narrow** the exported-internals surface now. Mark StateManager / strategies / handlers / SourceManager as *advanced* in README (T-25). Revisit in a future major. |
| Q6 | **No second published artifact** for time-stretch. Core ships the `ITimeStretchNode` interface + DI point only (T-24 step 7 cancelled). Reference plugin is documented as a README recipe. Rubber Band's GPL licensing confirmed unacceptable for the default recommendation; recommend MIT options (SoundTouchJS, Signalsmith Stretch). |

## Task Amendments

### T-04 — CORS logic reworked (auto-retry CANCELLED)

The original step 4 ("catch media error, retry once without crossOrigin") is
**cancelled**. Rationale: `MediaError` cannot distinguish a CORS rejection from
a 404 or a broken URL — both surface as the same media error — so a blind
retry would double the time-to-failure of every honest load error.

Replacement:

1. `crossOrigin="anonymous"` is set **only when the audio graph is actually
   needed for this load**: `webAudioRouting === 'always'` **and** graph
   features are in use (EQ / analyser-visualizer / fades / normalization —
   determined by options or prior API usage), or the strategy is `webaudio`.
   If no graph feature is used → element loads without `crossOrigin`, graph is
   not built, `player.graph === null` for that load.
2. **No automatic retry-fallback.** Instead add
   `PlayerOptions.corsFallback?: boolean` (default `false`). When `true`:
   exactly one retry without `crossOrigin` and without graph routing, one
   `playerLogger.warn` naming the consequence (EQ/fades/analyser disabled for
   this track). Retry must respect the load signal (T-01). When `false`
   (default): the media error surfaces as-is, no retry.
3. All other T-04 steps (the `webAudioRouting` option itself, no-AudioContext
   on `'never'`, `graph === null` handling in volume paths) stand unchanged.

Additional acceptance criterion: *"no graph features requested → element has
no crossOrigin attribute"*.

### T-06 — moved earlier

T-06 (Playwright + local HLS fixtures) executes **before T-03 and T-04**.
Native-HLS selection and crossOrigin behavior are unverifiable in jsdom;
without real WebKit those tasks are fixed blind.

**Execution order: T-01 → T-02 → T-06 → T-03 → T-04 → T-05 → then the rest
of the P1/P2 list as ordered in the audit.**

### T-20 — DEFERRED (do not implement in this pass)

Excluded from this pass. The direction is sound
(`createMediaElementSource` is once-per-element), but a single shared
`HTMLAudioElement` captured in turn by the HTML5 strategy, hls.js, and native
HLS is a magnet for residual-state bugs. Revisit as a separate iteration after
T-03 and T-05 have settled in real use. F-24 risk accepted for now. Mark as
deferred in `progress.md`; write no code.

### T-22 — split into two tasks

- **T-22a** (non-breaking): PlaybackRate clamp consistency (F-26),
  `playerLogger` instead of raw `console.debug` (F-33), transition-result
  logging at load-critical sites (F-31). Ships whenever convenient.
- **T-22b** (breaking, type-level): remove `ReadableStream<Uint8Array>` from
  `AudioSource.data` (F-27). Ships **only in the major release** together with
  T-02 and T-10 (see T-26).

### T-14 — Breaking clarified

Choose the **optional-with-fallback** variant (`handler.reset?.()`) so the
task stays non-breaking for external custom handlers. Changelog note still
required.

### T-26 — NEW task: release hygiene (runs last)

The plan contains at least three breaking changes (T-02, T-10, T-22b) plus the
semi-breaking T-14, and the repo has no CHANGELOG. Final task:

1. Create `CHANGELOG.md` (Keep a Changelog format); record the current
   published version as the baseline entry.
2. Collect all breaking changes into **one major release**. For each: what
   changed, why, and what a consumer must do.
3. Add a **Migration** section to the README linking to the CHANGELOG
   (coordinate with T-25's TOC).
4. Verify the `package.json` version bump follows semver.

Acceptance: CHANGELOG exists and lists every breaking task by ID; README has
the Migration section; version bump is a major.

## Effective task list for this pass

P0/P1 order: T-01 → T-02 → T-06 → T-03 → T-04 → T-05 → T-08 → T-09 → T-10 →
T-11 → T-12 → T-13 → T-14 → T-15 → T-23 → T-25 (after its deps).
P2 as convenient: T-07, T-16, T-17, T-18, T-19, T-21, T-22a, T-24.
Major-release gate: T-22b, then T-26 last.
Deferred: T-20.
