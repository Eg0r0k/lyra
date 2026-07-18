import { defineConfig, devices } from "@playwright/test";

/**
 * Browser matrix for lyra-audio. Runs OUTSIDE the vitest suite (jsdom) — these
 * exercise real engines for things jsdom cannot: real decode, real HLS, gesture
 * unlock, and native-HLS capability.
 *
 * Fixtures are served locally (e2e/server.mjs); no network access is required.
 * Run with `pnpm test:browser` (which builds dist/ first).
 */

const APP_PORT = Number(process.env.APP_PORT ?? 4173);
const BASE_URL = `http://localhost:${APP_PORT}`;

// Chromium needs an explicit flag to allow programmatic playback without a
// gesture; the strict project below omits it to test the gesture-unlock flow.
const CHROMIUM_AUTOPLAY_ARGS = ["--autoplay-policy=no-user-gesture-required"];

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: "node e2e/server.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: CHROMIUM_AUTOPLAY_ARGS },
      },
      testMatch: [
        "**/load-play.spec.ts",
        "**/webaudio.spec.ts",
        "**/hls.spec.ts",
      ],
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "media.autoplay.default": 0,
            "media.autoplay.blocking_policy": 0,
          },
        },
      },
      testMatch: ["**/load-play.spec.ts", "**/webaudio.spec.ts"],
    },
    {
      // WebKit on Windows is the flaky engine for this repo's author machine —
      // allow retries rather than skipping so real regressions still surface.
      //
      // NOTE: the Playwright WebKit build on Windows ships NO Web Audio API
      // (window.AudioContext === undefined) and NO native HLS. Since the library
      // routes all playback through an AudioContext, no playback path can run
      // here — so WebKit only runs the honest native-HLS negative. Real Safari
      // playback / native HLS is covered by manual iOS/macOS testing (README).
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      retries: 2,
      testMatch: ["**/native-hls.spec.ts"],
    },
    {
      // Strict autoplay policy for the gesture-unlock flow: play() must reject
      // before a gesture and succeed after a click. The policy is set
      // explicitly — Chromium's automation default lets programmatic play
      // through, which would defeat the test.
      name: "chromium-strict-autoplay",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--autoplay-policy=document-user-activation-required"],
        },
      },
      testMatch: ["**/unlock.spec.ts"],
    },
  ],
});
