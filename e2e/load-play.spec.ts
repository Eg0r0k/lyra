import { test, expect } from "@playwright/test";
import { gotoHarness } from "./helpers";

// Runs on chromium, firefox, webkit (see playwright.config.ts).
// Guards the real HTML5 URL load -> play -> ended path with a license-free PCM
// WAV fixture (decodes in every engine, including WebKit-on-Windows).
test("loads a WAV URL and plays through to ended", async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const player = new window.Lyra.Player({ mode: "html5" });

    let errored: unknown = null;
    player.on("error", (e) => {
      errored = e;
    });

    await player.load("/fixtures/silence.wav");

    const ended = Promise.withResolvers<void>();
    player.on("ended", () => ended.resolve());

    await player.play();
    const playingState = player.state;
    const duration = Number(player.duration);
    await ended.promise;
    const endedState = player.state;

    await player.dispose();
    return { errored, playingState, endedState, duration };
  });

  expect(result.errored).toBeNull();
  expect(result.playingState).toBe("playing");
  expect(result.endedState).toBe("ready");
  expect(result.duration).toBeGreaterThan(1);
});
