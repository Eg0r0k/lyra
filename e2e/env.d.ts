import type * as LyraNS from "../src/index";
import type HlsNS from "hls.js";

declare global {
  interface Window {
    /** Full library namespace exposed by the harness page. */
    Lyra: typeof LyraNS;
    /** hls.js constructor exposed by the harness page. */
    Hls: typeof HlsNS;
    /** Set true once the harness module has loaded. */
    __ready?: boolean;
    /** Scratch slot for tests that span multiple page.evaluate() calls. */
    __player?: LyraNS.Player;
  }
}

export {};
