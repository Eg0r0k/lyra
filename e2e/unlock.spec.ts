import { test, expect } from "@playwright/test";
import { gotoHarness } from "./helpers";

// chromium-strict-autoplay project (--autoplay-policy=document-user-activation-required).
// Gesture-unlock flow (F-16 class): programmatic play() is blocked before any
// user gesture and succeeds after a real click.
//
// Reality check: Playwright's Chromium build on this machine does NOT enforce
// autoplay blocking in automation — a raw <audio>.play() resolves and the
// AudioContext auto-runs without a gesture, even with the strict policy flag.
// When blocking is not enforced there is nothing to assert, so the test skips
// with a clear reason. The negative (PLAYBACK_NOT_ALLOWED without a gesture) is
// covered by jsdom unit tests (T-02); real gesture unlock is a manual
// device/browser check (see README). If a future engine build enforces the
// policy, this test runs its assertions automatically.
test("play() is blocked before a gesture and works after a click", async ({ page }) => {
  await gotoHarness(page);

  const enforcesAutoplayBlocking = await page.evaluate(async () => {
    const audio = document.createElement("audio");
    audio.src = "/fixtures/silence.wav";
    try {
      await audio.play();
      audio.pause();
      return false; // resolved without a gesture -> blocking not enforced
    } catch {
      return true;
    }
  });

  test.skip(
    !enforcesAutoplayBlocking,
    "engine build does not enforce autoplay blocking in automation (covered by unit tests + manual)",
  );

  const blocked = await page.evaluate(async () => {
    const player = new window.Lyra.Player({ mode: "html5" });
    window.__player = player;

    await player.load("/fixtures/silence.wav");

    let code: unknown = null;
    try {
      await player.play();
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) {
        code = e.code;
      }
    }

    return {
      code,
      expected: window.Lyra.PlayerErrorCode.PLAYBACK_NOT_ALLOWED,
      state: player.state,
    };
  });

  expect(blocked.code).toBe(blocked.expected);
  expect(blocked.state).toBe("ready");

  // Real user gesture -> sticky activation for the page.
  await page.click("#gesture");

  const played = await page.evaluate(async () => {
    const player = window.__player;
    if (!player) throw new Error("player missing");

    await player.play();
    const state = player.state;
    const isPlaying = player.isPlaying;

    await player.dispose();
    return { state, isPlaying };
  });

  expect(played.state).toBe("playing");
  expect(played.isPlaying).toBe(true);
});
