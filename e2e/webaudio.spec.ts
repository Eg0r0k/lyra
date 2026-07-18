import { test, expect } from "@playwright/test";
import { gotoHarness } from "./helpers";

// Runs on chromium, firefox, webkit.
// Exercises the Web Audio path: fetch bytes -> decodeAudioData -> play -> ended.
// PCM WAV is used so decodeAudioData succeeds in every engine.
test("decodes a WAV buffer and plays via Web Audio", async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const player = new window.Lyra.Player({ mode: "webaudio" });

    let errored: unknown = null;
    player.on("error", (e) => {
      errored = e;
    });

    const res = await fetch("/fixtures/silence.wav");
    const bytes = await res.arrayBuffer();

    await player.load({ data: bytes });
    const mode = player.mode;
    const duration = Number(player.duration);

    const ended = Promise.withResolvers<void>();
    player.on("ended", () => ended.resolve());

    await player.play();
    const playingState = player.state;
    await ended.promise;
    const endedState = player.state;

    await player.dispose();
    return { errored, mode, duration, playingState, endedState };
  });

  expect(result.errored).toBeNull();
  expect(result.mode).toBe("webaudio");
  expect(result.duration).toBeGreaterThan(1);
  expect(result.playingState).toBe("playing");
  expect(result.endedState).toBe("ready");
});
