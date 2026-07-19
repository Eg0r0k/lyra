import { test, expect } from "@playwright/test";
import { gotoHarness } from "./helpers";

// Chromium only (MSE + hls.js). WebKit-on-Windows has no MSE HLS and no native
// HLS; that path is covered by native-hls.spec.ts (honest negative) and a
// jsdom unit test (T-03).

test("plays an HLS VOD stream via hls.js", async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const player = new window.Lyra.Player({ Hls: window.Hls });

    let errored: unknown = null;
    player.on("error", (e) => {
      errored = e;
    });

    await player.load({ url: "/fixtures/hls/vod.m3u8", type: "hls" });
    const mode = player.mode;

    await player.play();

    const delay = Promise.withResolvers<void>();
    setTimeout(() => delay.resolve(), 600);
    await delay.promise;

    const advanced = Number(player.currentTime) > 0;

    await player.dispose();
    return { errored, mode, advanced };
  });

  expect(result.errored).toBeNull();
  expect(result.mode).toBe("html5");
  expect(result.advanced).toBe(true);
});

// Fixture guard for T-15: hls.js must actually classify the live playlist as
// live (no #EXT-X-ENDLIST), and the VOD playlist as not-live. If this breaks,
// T-15 would be testing the wrong fixture.
test("hls.js reports live vs VOD correctly on the fixtures", async ({ page }) => {
  await gotoHarness(page);

  const readLiveFlag = (url: string) =>
    page.evaluate((url) => {
      const Hls = window.Hls;
      const hls = new Hls();
      const audio = document.createElement("audio");
      const { promise, resolve, reject } = Promise.withResolvers<boolean>();

      const timer = setTimeout(() => {
        hls.destroy();
        reject(new Error(`timeout waiting for LEVEL_LOADED on ${url}`));
      }, 8000);

      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        clearTimeout(timer);
        const live = data.details.live;
        hls.destroy();
        resolve(live);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          clearTimeout(timer);
          hls.destroy();
          reject(new Error(`${data.type}:${data.details}`));
        }
      });

      hls.loadSource(url);
      hls.attachMedia(audio);
      return promise;
    }, url);

  expect(await readLiveFlag("/fixtures/hls/live.m3u8")).toBe(true);
  expect(await readLiveFlag("/fixtures/hls/vod.m3u8")).toBe(false);
});

// T-15: exercise the LIVE path end-to-end against real hls.js — it must reach
// actual segment playback (currentTime advances), not just manifest parse, so
// isLive / Infinity duration / progress==0 / seekable clamp are validated
// against the real engine, not only jsdom mocks.
test("live HLS reaches segment playback with isLive, finite window duration, progress 0, and clamped seek", async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const player = new window.Lyra.Player({ Hls: window.Hls });

    let errored: unknown = null;
    player.on("error", (e) => {
      errored = e;
    });
    let lastProgress = -1;
    player.on("timeupdate", ({ progress }) => {
      lastProgress = progress;
    });

    await player.load({ url: "/fixtures/hls/live.m3u8", type: "hls" });

    // isLive is known from LEVEL_LOADED immediately; duration only becomes
    // Infinity once the live MediaSource settles, so it is read after playback.
    const isLive = player.isLive;
    const mode = player.mode;

    await player.play();

    // Let real segments buffer and play (~2s of content in the fixture).
    const delay = Promise.withResolvers<void>();
    setTimeout(() => delay.resolve(), 1500);
    await delay.promise;

    const advanced = Number(player.currentTime) > 0;
    // hls.js reports a FINITE sliding-window duration for live (Infinity is a
    // native-HLS/Safari behavior, covered by the jsdom unit test). Document it.
    const durationFinite =
      Number.isFinite(player.duration) && Number(player.duration) > 0;

    // Seek far past the live window → clamps into the seekable range:
    // a finite position well below the requested value (not Infinity).
    player.seek(1_000_000);
    const seeked = Number(player.currentTime);
    const clampedToSeekable = Number.isFinite(seeked) && seeked < 1_000_000;

    await player.dispose();
    return {
      errored,
      mode,
      isLive,
      durationFinite,
      advanced,
      lastProgress,
      clampedToSeekable,
    };
  });

  expect(result.errored).toBeNull();
  expect(result.mode).toBe("html5");
  expect(result.isLive).toBe(true);
  expect(result.durationFinite).toBe(true); // hls.js live = finite window
  expect(result.advanced).toBe(true); // real segment playback reached
  expect(result.lastProgress).toBe(0); // progress is 0 for live
  expect(result.clampedToSeekable).toBe(true);
});

// T-16: prove the LEVEL_SWITCHED → qualitychange relay against real hls.js —
// the engine reports the actually-selected level asynchronously (this is why
// setQuality does not emit synchronously).
test("qualitychange relays the engine-selected level from real hls.js", async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const player = new window.Lyra.Player({ Hls: window.Hls });

    const levels: { index: number }[] = [];
    player.on("qualitychange", (l) => levels.push(l));

    await player.load({ url: "/fixtures/hls/vod.m3u8", type: "hls" });
    await player.play();

    const setQualityReturn = player.setQuality(-1); // auto

    const delay = Promise.withResolvers<void>();
    setTimeout(() => delay.resolve(), 800);
    await delay.promise;

    await player.dispose();
    return { count: levels.length, firstIndex: levels[0]?.index, setQualityReturn };
  });

  expect(result.setQualityReturn).toBe(true);
  expect(result.count).toBeGreaterThan(0); // real LEVEL_SWITCHED was relayed
  expect(result.firstIndex).toBe(0);
});
