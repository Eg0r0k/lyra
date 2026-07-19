// Size regression guard for the published ESM entry. Run via `pnpm size`
// (builds first). Portable (Node zlib) — no external size tooling.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Gzipped-byte budget for dist/index.js. Baseline ~20.6 KB (2026-07-19); the
// headroom catches an accidental bloat (e.g. a heavy dep pulled into the barrel)
// without flapping on small changes. Bump deliberately with a note when the
// library genuinely grows.
const BUDGET_BYTES = 24 * 1024;
const ENTRY = "dist/index.js";

const raw = readFileSync(ENTRY);
const gzipped = gzipSync(raw).length;

const kb = (n) => (n / 1024).toFixed(2);
console.log(
  `${ENTRY}: ${kb(gzipped)} KB gzip (${gzipped} B) — budget ${kb(BUDGET_BYTES)} KB`,
);

if (gzipped > BUDGET_BYTES) {
  console.error(
    `Size budget exceeded by ${gzipped - BUDGET_BYTES} B. Trim the bundle or bump the budget deliberately.`,
  );
  process.exit(1);
}
