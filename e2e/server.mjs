// Dependency-free static server for the Playwright browser suite.
//
// Two origins are exposed so T-04 can exercise real cross-origin CORS behavior
// (same-origin requests never trigger crossOrigin="anonymous" checks):
//
//   APP origin      http://localhost:<PORT>      (default 4173)
//     /                      -> e2e/app/index.html (harness page)
//     /app/*                 -> e2e/app/*
//     /dist/*                -> dist/*            (built library)
//     /vendor/hls.mjs        -> node_modules/hls.js/dist/hls.mjs
//     /fixtures/*            -> e2e/fixtures/*    (same-origin, ACAO:* anyway)
//
//   CROSS origin    http://localhost:<PORT+1>    (default 4174)
//     /cors/*                -> e2e/fixtures/*  WITH Access-Control-Allow-Origin:*
//     /nocors/*              -> e2e/fixtures/*  WITHOUT any CORS header
//
// Ports are exported to the tests via APP_BASE_URL / CROSS_BASE_URL.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const APP_PORT = Number(process.env.APP_PORT ?? 4173);
const CROSS_PORT = Number(process.env.CROSS_PORT ?? APP_PORT + 1);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4s": "audio/mp4",
  ".mp4": "audio/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
};

function contentType(path) {
  const dot = path.lastIndexOf(".");
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

// Resolve a URL path to an absolute file path, refusing traversal outside base.
function safeJoin(base, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(base, clean);
  if (!full.startsWith(base)) return null;
  return full;
}

async function sendFile(req, res, filePath, extraHeaders = {}) {
  let info;
  try {
    info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  const body = await readFile(filePath);
  const type = contentType(filePath);
  const range = req.headers.range;

  // Minimal single-range support (media elements/WebKit issue range requests).
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match) {
    const total = body.length;
    let start = match[1] === "" ? 0 : Number(match[1]);
    let end = match[2] === "" ? total - 1 : Number(match[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
      end = total - 1;
    }
    res.writeHead(206, {
      ...extraHeaders,
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
    return;
  }

  res.writeHead(200, {
    ...extraHeaders,
    "content-type": type,
    "accept-ranges": "bytes",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

const appServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${APP_PORT}`);
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    return sendFile(req, res, join(__dirname, "app", "index.html"));
  }
  if (path.startsWith("/app/")) {
    const f = safeJoin(join(__dirname, "app"), path.slice("/app/".length));
    return f ? sendFile(req, res, f) : res.writeHead(403).end();
  }
  if (path.startsWith("/dist/")) {
    const f = safeJoin(join(ROOT, "dist"), path.slice("/dist/".length));
    return f ? sendFile(req, res, f) : res.writeHead(403).end();
  }
  if (path === "/vendor/hls.mjs") {
    return sendFile(req, res, join(ROOT, "node_modules", "hls.js", "dist", "hls.mjs"));
  }
  if (path.startsWith("/fixtures/")) {
    const f = safeJoin(join(__dirname, "fixtures"), path.slice("/fixtures/".length));
    return f
      ? sendFile(req, res, f, { "access-control-allow-origin": "*" })
      : res.writeHead(403).end();
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

const crossServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CROSS_PORT}`);
  const path = url.pathname;

  if (path.startsWith("/cors/")) {
    const f = safeJoin(join(__dirname, "fixtures"), path.slice("/cors/".length));
    return f
      ? sendFile(req, res, f, { "access-control-allow-origin": "*" })
      : res.writeHead(403).end();
  }
  if (path.startsWith("/nocors/")) {
    const f = safeJoin(join(__dirname, "fixtures"), path.slice("/nocors/".length));
    return f ? sendFile(req, res, f) : res.writeHead(403).end();
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

appServer.listen(APP_PORT, () => {
  console.log(`[e2e] app origin      http://localhost:${APP_PORT}`);
});
crossServer.listen(CROSS_PORT, () => {
  console.log(`[e2e] cross origin    http://localhost:${CROSS_PORT}`);
});
