// Local dev server for testing — serves the built frontend (dist/) AND mounts the
// Vercel-style api/*.js handlers on the SAME origin, so the app's relative /api/*
// calls work with no CORS and no Vercel login. NOT used in production (Vercel runs
// the functions there). Run: node --env-file=.env scripts/dev-server.mjs
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".map": "application/json",
};

function wrapRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.headersSent) res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
  return res;
}

async function handleApi(req, res, name) {
  let mod;
  try {
    mod = await import(join(ROOT, "api", name + ".js") + `?t=${Date.now()}`); // cache-bust for edits
  } catch (e) {
    res.statusCode = 404; res.end(JSON.stringify({ error: `No api/${name}: ${e.message}` })); return;
  }
  // Every endpoint except the webhook expects a parsed JSON body (as Vercel provides).
  // The webhook needs the raw stream for signature verification — leave it intact.
  if (name !== "stripe-webhook" && req.method !== "GET") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
  }
  wrapRes(res);
  try { await mod.default(req, res); }
  catch (e) { console.error(`[api/${name}]`, e); if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); } }
}

async function serveStatic(req, res, pathname) {
  let fp = join(DIST, pathname === "/" ? "/index.html" : pathname);
  try { if ((await stat(fp)).isDirectory()) fp = join(fp, "index.html"); }
  catch (_) { fp = join(DIST, "index.html"); } // SPA fallback
  try {
    const data = await readFile(fp);
    res.setHeader("Content-Type", MIME[extname(fp)] || "application/octet-stream");
    res.end(data);
  } catch (e) { res.statusCode = 404; res.end("Not found"); }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname.startsWith("/api/")) return handleApi(req, res, u.pathname.slice(5).replace(/\/+$/, ""));
  return serveStatic(req, res, u.pathname);
}).listen(PORT, () => console.log(`[dev-server] serving dist/ + api/* on http://localhost:${PORT}`));
