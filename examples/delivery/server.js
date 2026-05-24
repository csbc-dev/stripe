// One dependency-free static delivery server for all four examples.
//
// It is the canonical way the examples are *served* (the per-client `npm run
// dev` Vite server is for hot-reload authoring only — see ../CONVENTIONS.md §4).
// Each built client is served at its own fixed port; `wcstack-state` is served
// verbatim (it is buildless) together with the `/vendor/*` mounts its
// <importmap> resolves to the local repo build.
//
//   react   → react/dist     on 5173
//   vue     → vue/dist        on 5174
//   vanilla → vanilla/dist    on 5175
//   wcstack → wcstack-state/  on 5176  (+ /vendor/* → repo build)
//
// Node built-ins only — no `npm install` needed here. Run `npm run build` in
// each client (and `npm run build` at the repo root for the /vendor mounts)
// first; this server only serves what is already on disk.
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `resolve` strips any trailing separator fileURLToPath leaves on the directory
// URL, so the path-traversal guard's `root + sep` check is exact.
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const examplesRoot = resolve(here, "..");
const repoRoot = resolve(here, "..", "..");
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// URL prefix -> filesystem base directory, for the buildless wcstack example's
// <importmap>. @csbc-dev/stripe and its @wc-bindable/* deps come straight from
// the repo build (so run `npm run build` at the repo root first).
const VENDORS = [
  ["/vendor/csbc/", join(repoRoot, "dist")],
  ["/vendor/wcb-core/", join(repoRoot, "node_modules", "@wc-bindable", "core", "dist")],
  ["/vendor/wcb-remote/", join(repoRoot, "node_modules", "@wc-bindable", "remote", "dist")],
];

// Built Vite clients (self-contained — the bundle inlines @csbc-dev/stripe, so
// these need no /vendor mounts) and the buildless wcstack example.
const TARGETS = [
  { name: "react", port: Number(process.env.REACT_PORT ?? 5173), root: join(examplesRoot, "react", "dist"), spaFallback: true, vendors: [] },
  { name: "vue", port: Number(process.env.VUE_PORT ?? 5174), root: join(examplesRoot, "vue", "dist"), spaFallback: true, vendors: [] },
  { name: "vanilla", port: Number(process.env.VANILLA_PORT ?? 5175), root: join(examplesRoot, "vanilla", "dist"), spaFallback: true, vendors: [] },
  { name: "wcstack-state", port: Number(process.env.WCSTACK_PORT ?? 5176), root: join(examplesRoot, "wcstack-state"), spaFallback: false, vendors: VENDORS },
];

function safeResolve(base, relative) {
  const full = normalize(join(base, relative));
  const root = normalize(base);
  const sep = process.platform === "win32" ? "\\" : "/";
  // Path-traversal guard: the resolved path must stay under base.
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

async function safeRealResolve(base, relative) {
  const full = safeResolve(base, relative);
  if (!full) return null;

  const [realBase, realFull] = await Promise.all([
    realpath(base).catch(() => null),
    realpath(full).catch(() => null),
  ]);

  // If the target does not exist yet, fall back to the lexical path so callers
  // can still return a normal 404.
  if (!realBase || !realFull) return full;

  const sep = process.platform === "win32" ? "\\" : "/";
  if (realFull !== realBase && !realFull.startsWith(realBase + sep)) return null;
  return realFull;
}

async function readFileOrNull(filePath) {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function sendData(res, filePath, data, method) {
  res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(data);
}

function sendText(res, status, message, method) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(message);
}

function makeHandler({ root, vendors, spaFallback }) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);

    // Vendor mounts (wcstack only) take precedence over the static root.
    for (const [prefix, base] of vendors) {
      if (urlPath.startsWith(prefix)) {
        const fp = await safeRealResolve(base, urlPath.slice(prefix.length));
        if (!fp) {
          sendText(res, 403, "forbidden", req.method);
          return;
        }
        if (req.method === "HEAD") {
          const info = await statOrNull(fp);
          if (!info || !info.isFile()) {
            sendText(res, 404, "not found", req.method);
            return;
          }
          sendData(res, fp, null, req.method);
          return;
        }
        const data = await readFileOrNull(fp);
        if (!data) {
          sendText(res, 404, "not found", req.method);
          return;
        }
        sendData(res, fp, data, req.method);
        return;
      }
    }

    if (urlPath === "/" || urlPath.endsWith("/")) urlPath += "index.html";
    const fp = await safeRealResolve(root, urlPath.replace(/^\/+/, ""));
    if (!fp) {
      sendText(res, 403, "forbidden", req.method);
      return;
    }

    let servePath = fp;
    let data = null;
    if (req.method === "GET") data = await readFileOrNull(fp);
    // Built SPAs have no router here, but a not-found GET falling back to
    // index.html keeps a manual deep-link from 404ing.
    if (!data && spaFallback && !extname(fp)) {
      servePath = join(root, "index.html");
      servePath = (await safeRealResolve(root, "index.html")) ?? servePath;
      if (req.method === "GET") data = await readFileOrNull(servePath);
    }

    if (req.method === "HEAD") {
      const info = await statOrNull(servePath);
      if (!info || !info.isFile()) {
        sendText(res, 404, "not found", req.method);
        return;
      }
      sendData(res, servePath, null, req.method);
      return;
    }

    if (!data) {
      sendText(res, 404, "not found", req.method);
      return;
    }
    sendData(res, servePath, data, req.method);
  };
}

for (const target of TARGETS) {
  const server = createServer(makeHandler(target));
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`[delivery] ${target.name}: port ${target.port} is already in use. Free it or override the *_PORT env var.`);
    } else {
      console.error(`[delivery] ${target.name}: server error:`, err);
    }
    // Fail the whole process so a partial bring-up isn't mistaken for success.
    process.exit(1);
  });
  server.listen(target.port, HOST, () => {
    console.log(`[delivery] ${target.name.padEnd(13)} http://${HOST}:${target.port}/  ←  ${target.root}`);
  });
}

console.log("[delivery] static delivery for built clients + buildless wcstack-state");
console.log("[delivery] build first: `npm run build` per client, and at the repo root for /vendor/*");
