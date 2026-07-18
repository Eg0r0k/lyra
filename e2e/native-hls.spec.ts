import { test, expect } from "@playwright/test";
import { gotoHarness } from "./helpers";

// WebKit only. Tier 2 of the native-HLS verification scheme:
//   1. handler selection (canPlayType truthy) -> jsdom unit test (T-03)
//   2. honest negative in a real engine       -> THIS test
//   3. real native-HLS playback               -> manual iOS/macOS-Safari (README)
//
// The Playwright WebKit build on Windows exposes no native HLS
// (canPlayType('application/vnd.apple.mpegurl') === ""), so with no hls.js
// injected an .m3u8 must reject with LOAD_NOT_SUPPORTED. This stays valid after
// T-03: NativeHlsHandler only engages when canPlayType is truthy.
test("m3u8 without hls.js and without native HLS rejects LOAD_NOT_SUPPORTED", async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(async () => {
    const nativeHls = document
      .createElement("audio")
      .canPlayType("application/vnd.apple.mpegurl");

    const player = new window.Lyra.Player(); // no Hls injected

    let code: unknown = null;
    try {
      await player.load({ url: "/fixtures/hls/vod.m3u8", type: "hls" });
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) {
        code = e.code;
      }
    }

    const state = player.state;
    await player.dispose();
    return {
      nativeHls,
      code,
      expected: window.Lyra.PlayerErrorCode.LOAD_NOT_SUPPORTED,
      state,
    };
  });

  // Documents the platform gap: this engine truly has no native HLS.
  expect(result.nativeHls).toBe("");
  expect(result.code).toBe(result.expected);
  expect(result.state).toBe("error");
});
