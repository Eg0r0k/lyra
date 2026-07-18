import type { Page } from "@playwright/test";

/** Navigate to the harness page and wait for the module to expose window.Lyra. */
export async function gotoHarness(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true);
}

const APP_PORT = Number(process.env.APP_PORT ?? 4173);
const CROSS_PORT = Number(process.env.CROSS_PORT ?? APP_PORT + 1);

/** Cross-origin base for CORS tests (T-04). `/cors/*` sends ACAO:*, `/nocors/*` does not. */
export const CROSS_BASE_URL = `http://localhost:${CROSS_PORT}`;
