import { test, expect } from "@playwright/test";
import { gotoHarness, CROSS_BASE_URL } from "./helpers";

/**
 * T-04 CORS matrix on a real engine (chromium) — closes F-46 (previously the
 * dual-origin fixture server existed but no spec used it, so crossOrigin
 * behavior was verified only under jsdom mocks).
 *
 * The fixture server (e2e/server.mjs) serves the SAME file with `ACAO: *` under
 * `/cors/*` and with no CORS header under `/nocors/*`. Routed html5
 * (`webAudioRouting: 'always'`, the default) sets `crossOrigin="anonymous"` for
 * cross-origin URLs, so a no-CORS resource fails the media load unless routing
 * (and thus crossOrigin) is dropped. The three scenarios together prove
 * crossOrigin is actually being set: it fails routed (1), the SAME URL recovers
 * when the fallback drops crossOrigin (2), and a CORS-enabled URL works routed (3).
 */

test("routed cross-origin load without CORS headers fails (crossOrigin set)", async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(async (base) => {
    const player = new window.Lyra.Player({ mode: "html5" }); // default routing 'always'
    let threw = false;
    try {
      await player.load(`${base}/nocors/silence.wav`);
    } catch {
      threw = true;
    }
    const state = player.state;
    await player.dispose();
    return { threw, state };
  }, CROSS_BASE_URL);

  // crossOrigin="anonymous" against a no-ACAO resource → the media load fails
  // and load() rejects into the error state.
  expect(result.threw).toBe(true);
  expect(result.state).toBe("error");
});

test("corsFallback retries the same no-CORS URL un-routed and plays", async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(async (base) => {
    const player = new window.Lyra.Player({
      mode: "html5",
      corsFallback: true,
    });
    let errored = false;
    player.on("error", () => {
      errored = true;
    });

    await player.load(`${base}/nocors/silence.wav`);
    const graphNull = player.graph === null;

    await player.play();
    const state = player.state;

    await player.dispose();
    return { errored, graphNull, state };
  }, CROSS_BASE_URL);

  // The fallback drops crossOrigin and graph routing, so the exact same URL that
  // failed in scenario 1 now loads and plays — with no graph and no error event.
  expect(result.errored).toBe(false);
  expect(result.graphNull).toBe(true);
  expect(result.state).toBe("playing");
});

test("routed cross-origin load with CORS headers keeps the graph", async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(async (base) => {
    const player = new window.Lyra.Player({ mode: "html5" });
    let errored = false;
    player.on("error", () => {
      errored = true;
    });

    await player.load(`${base}/cors/silence.wav`);
    const graphNull = player.graph === null;

    await player.play();
    const state = player.state;

    await player.dispose();
    return { errored, graphNull, state };
  }, CROSS_BASE_URL);

  // ACAO:* satisfies the crossOrigin="anonymous" request → routed playback works
  // and the graph stays available (EQ/analyser/fades usable).
  expect(result.errored).toBe(false);
  expect(result.graphNull).toBe(false);
  expect(result.state).toBe("playing");
});
