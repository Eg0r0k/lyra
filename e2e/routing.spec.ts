import { test, expect } from "@playwright/test";
import { gotoHarness } from "./helpers";

// webAudioRouting:'never' → plain HTML5 element, no AudioContext, graph === null.
// Runs on chromium, firefox, AND webkit: this is the only playback path that
// works under the Windows Playwright WebKit build (which has no Web Audio API),
// so it doubles as the proof that 'never' truly needs no AudioContext (T-04).
test("plays html5 with webAudioRouting:'never' and no graph/AudioContext", async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const player = new window.Lyra.Player({
      mode: "html5",
      webAudioRouting: "never",
    });

    let errored: unknown = null;
    player.on("error", (e) => {
      errored = e;
    });

    await player.load("/fixtures/silence.wav");
    const graphNull = player.graph === null;

    const ended = Promise.withResolvers<void>();
    player.on("ended", () => ended.resolve());

    await player.play();
    const playingState = player.state;
    await ended.promise;
    const endedState = player.state;

    await player.dispose();
    return { errored, graphNull, playingState, endedState };
  });

  expect(result.errored).toBeNull();
  expect(result.graphNull).toBe(true);
  expect(result.playingState).toBe("playing");
  expect(result.endedState).toBe("ready");
});
