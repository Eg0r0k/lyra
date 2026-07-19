# Open Threads

> Side questions and requests raised by the reviewer that fall outside the
> task currently in flight. Any off-task request is logged here immediately;
> before starting each next task, this file is checked for `OPEN` items.
>
> Line format: `date | summary | status (OPEN/ANSWERED) | where closed`.

| Date | Thread | Status | Where closed |
|------|--------|--------|--------------|
| 2026-07-19 | F-36: `preAttachedMedia` metadata flag is vestigial after T-09 merged the pre-attached and no-sourceUrl branches. Remove it. | OPEN | Slated for T-22a (housekeeping bundle: F-26/F-33/F-31). Track there. |
| 2026-07-19 | After T-10: `fadeOut()` without pause/stop leaves fade multiplier at 0; a later `setVolume(0.8)` reports volume 0.8 but output stays silent (mirror of F-13). Is it intended? Is there a getter for the multiplier? | ANSWERED | Intended multiplier semantics — resetting bare `fadeOut()` would jump to full volume mid-playback. Added `fadeMultiplier` getter (AudioGraph + Player) for observability + explicit regression test (`audio-graph.test.ts`). README doc requirement recorded for T-25 (see below). Commit `followup: fadeMultiplier getter + fade/unlock regression tests`. |
| 2026-07-19 | Does `unlockAudio` remove its `statechange` listener on the timeout path, or do repeated failed unlocks accumulate listeners on the context? | ANSWERED | No leak: `finish()` runs `removeEventListener` on every settle path (success, timeout, start-error). Added guard test: three consecutive failed unlocks → `statechangeListenerCount === 0` (`player.test.ts`, T-11 block; mock extended to track listeners). Same commit as above. |

## Deferred doc requirements (for T-25 README overhaul)

- **Fades section**: document that `fadeOut()` (without `fadeOutAndPause`/`fadeOutAndStop`) leaves the fade multiplier at 0 while playback continues; raising `volume` will NOT restore sound. Recovery is `fadeIn()` (or use the And-Pause/And-Stop variants). Note the new `player.fadeMultiplier` getter (0..1) alongside `isFading`, and that fade and volume are independent multipliers (T-10).
