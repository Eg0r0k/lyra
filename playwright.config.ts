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
        "**/routing.spec.ts",
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
      testMatch: [
        "**/load-play.spec.ts",
        "**/webaudio.spec.ts",
        "**/routing.spec.ts",
      ],
    },
    {
      // WebKit on Windows is the flaky engine for this repo's author machine —
      // allow retries rather than skipping so real regressions still surface.
      //
      // The Windows Playwright WebKit build has NO Web Audio API
      // (window.AudioContext === undefined) and NO native HLS, so graph-routed
      // playback and hls.js/native HLS can't run here. It DOES run:
      //  - native-hls.spec: the honest LOAD_NOT_SUPPORTED negative, and
      //  - routing.spec: plain html5 playback via webAudioRouting:'never' (no
      //    AudioContext) — the real proof T-04's 'never' path works on WebKit.
      // Real Safari/iOS graph + native HLS playback stays a manual check (README).
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      retries: 2,
      testMatch: ["**/native-hls.spec.ts", "**/routing.spec.ts"],
    },
    {
      // Strict autoplay policy for the gesture-unlock flow: play() must reject
      // before a gesture and succeed after a click.
      //
      // Playwright launches Chromium with
      // `--autoplay-policy=no-user-gesture-required` by DEFAULT (a plain `args`
      // override doesn't win against it), so `ignoreDefaultArgs` strips it and we
      // re-add the strict policy. This is the correct config for an engine that
      // honors it. NOTE: on this machine the Playwright chrome-headless-shell
      // (and Firefox with media.autoplay prefs) still does NOT gate audible
      // autoplay in automation, so unlock.spec self-skips after probing with an
      // audible tone. The assertions run automatically on any build that enforces
      // the policy. The negative is otherwise covered by jsdom unit tests (T-02)
      // and the manual checklist (e2e/README.md).
      name: "chromium-strict-autoplay",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--autoplay-policy=document-user-activation-required"],
          ignoreDefaultArgs: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
      testMatch: ["**/unlock.spec.ts"],
    },
  ],
});
