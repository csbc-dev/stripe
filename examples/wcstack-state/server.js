// Dependency-free static server for the buildless @wcstack/state example.
//
// @wcstack/state is "buildless": it reads the inline `<wcs-state>` module
// script and the `data-wcs` attributes at runtime. Running it through a bundler
// (Vite) would rewrite that inline module and break it — so we serve plain,
// untransformed files and resolve bare specifiers with an HTML <importmap>.
//
// `@wcstack/state` itself comes from the esm.run CDN; `@csbc-dev/stripe` and
// its `@wc-bindable/*` deps are served straight from the repo build under
// /vendor/* (so run `npm run build` at the repo root first).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `resolve` strips any trailing separator that fileURLToPath leaves on the
// directory URL — important so the path-traversal guard's `root + sep` check
// doesn't compare against a doubled separator.
const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(here, "..", "..");
const PORT = Number(process.env.PORT ?? 5176);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// URL prefix -> filesystem base directory.
const VENDORS = [
  ["/vendor/csbc/", join(repoRoot, "dist")],
  ["/vendor/wcb-core/", join(repoRoot, "node_modules", "@wc-bindable", "core", "dist")],
  ["/vendor/wcb-remote/", join(repoRoot, "node_modules", "@wc-bindable", "remote", "dist")],
];

function safeResolve(base, relative) {
  const full = normalize(join(base, relative));
  const root = normalize(base);
  // Path-traversal guard: the resolved path must stay under base.
  if (full !== root && !full.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) {
    return null;
  }
  return full;
}

async function send(res, filePath) {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  for (const [prefix, base] of VENDORS) {
    if (urlPath.startsWith(prefix)) {
      const fp = safeResolve(base, urlPath.slice(prefix.length));
      if (!fp) { res.writeHead(403); res.end("forbidden"); return; }
      await send(res, fp);
      return;
    }
  }

  const fp = safeResolve(here, urlPath.replace(/^\/+/, ""));
  if (!fp) { res.writeHead(403); res.end("forbidden"); return; }
  await send(res, fp);
});

// Fail loud on a port clash (mirrors the front-end Vite apps' strictPort:true)
// instead of crashing with a raw stack trace.
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[wcstack-state] port ${PORT} is already in use. Set PORT=<free port> and retry.`);
  } else {
    console.error("[wcstack-state] server error:", err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[wcstack-state] http://localhost:${PORT}`);
  console.log(`[wcstack-state] serving local @csbc-dev/stripe from ${join(repoRoot, "dist")}`);
  console.log(`[wcstack-state] (run "npm run build" at the repo root if /vendor/csbc 404s)`);
});
