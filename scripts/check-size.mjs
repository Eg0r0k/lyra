// Size + tree-shaking regression guard for the published ESM entry. Run via
// `pnpm size` (builds first). Portable (Node zlib + esbuild) — no size tooling.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const ENTRY = "dist/index.js";

// 1) Whole-bundle gzip budget. Baseline ~20 KB (2026-07-19); headroom catches an
// accidental bloat (e.g. a heavy dep pulled into the barrel) without flapping.
const BUDGET_BYTES = 24 * 1024;

// 2) Tree-shaking budget: importing ONLY PlayerError must DCE Player and the
// whole graph out of dist. Guards the T-21 fix (a static class field, or any
// module-scope side effect, would re-pin classes and blow this up). Baseline
// ~1.7 KB minified; 3 KB leaves room without hiding a real regression.
const DCE_BUDGET_BYTES = 3 * 1024;

const kb = (n) => (n / 1024).toFixed(2);
let failed = false;

const gzipped = gzipSync(readFileSync(ENTRY)).length;
console.log(
  `${ENTRY}: ${kb(gzipped)} KB gzip (${gzipped} B) — budget ${kb(BUDGET_BYTES)} KB`,
);
if (gzipped > BUDGET_BYTES) {
  console.error(`  ✗ gzip budget exceeded by ${gzipped - BUDGET_BYTES} B.`);
  failed = true;
}

const dce = await build({
  stdin: {
    contents: `import { PlayerError } from "./${ENTRY}";\nconsole.log(PlayerError.name);\n`,
    resolveDir: process.cwd(),
    loader: "js",
  },
  bundle: true,
  minify: true,
  format: "esm",
  write: false,
});
const dceBytes = dce.outputFiles[0].contents.length;
console.log(
  `PlayerError-only import: ${kb(dceBytes)} KB min (${dceBytes} B) — budget ${kb(DCE_BUDGET_BYTES)} KB`,
);
if (dceBytes > DCE_BUDGET_BYTES) {
  console.error(
    `  ✗ tree-shaking regression: importing only PlayerError pulls in ${dceBytes} B (> ${DCE_BUDGET_BYTES} B). A static class field or module-scope side effect likely pinned a class — see T-21.`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}
