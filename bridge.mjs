#!/usr/bin/env node
// Textbook Library Bridge
// ------------------------
// A small standalone agent that runs on the machine where the textbook
// library lives (e.g. Windows desktop with D:\Book Database). It scans the
// folder, uploads new/changed files to the cloud API, and (optionally)
// watches for changes in real time.
//
// Requirements: Node.js 18+ (for built-in fetch). No npm install needed.
//
// Configure via environment variables OR a .env file in this directory:
//   BRIDGE_URL          e.g. https://your-app.replit.app
//   BRIDGE_TOKEN        same secret as LIBRARY_BRIDGE_TOKEN on the server
//   LIBRARY_PATH        e.g. D:\Book Database
//   POLL_INTERVAL_MIN   (optional) full re-scan interval in minutes (default 30)
//   MAX_FILE_MB         (optional) skip files larger than this (default 200)
//   WATCH               (optional) "1" to watch for changes (default "1")
//
// Run: node bridge.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ---- env / .env loader -----------------------------------------------------
async function loadDotenv() {
  const envFile = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envFile)) return;
  const text = await fsp.readFile(envFile, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

await loadDotenv();

const BRIDGE_URL = (process.env.BRIDGE_URL || "").replace(/\/+$/, "");
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const LIBRARY_PATH = process.env.LIBRARY_PATH || "";
const POLL_INTERVAL_MIN = Math.max(1, Number.parseInt(process.env.POLL_INTERVAL_MIN || "30", 10));
const MAX_FILE_MB = Math.max(1, Number.parseInt(process.env.MAX_FILE_MB || "200", 10));
const WATCH = (process.env.WATCH || "1") !== "0";

if (!BRIDGE_URL || !BRIDGE_TOKEN || !LIBRARY_PATH) {
  console.error("Missing required env: BRIDGE_URL, BRIDGE_TOKEN, LIBRARY_PATH");
  console.error("Create a .env file in this directory or set them in the shell, then re-run.");
  process.exit(2);
}
if (!fs.existsSync(LIBRARY_PATH)) {
  console.error(`LIBRARY_PATH does not exist: ${LIBRARY_PATH}`);
  process.exit(2);
}

const ALLOWED_EXT = new Set([".pdf", ".epub", ".docx", ".doc", ".mobi", ".txt", ".rtf", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "$RECYCLE.BIN", "System Volume Information", ".git"]);
const MAX_BYTES = MAX_FILE_MB * 1024 * 1024;

const headersBase = {
  "Authorization": `Bearer ${BRIDGE_TOKEN}`,
};

function relPosix(file) {
  return path.relative(LIBRARY_PATH, file).split(path.sep).join("/");
}

async function* walk(root, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    console.warn(`[walk] cannot read ${root}: ${err.message}`);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (ALLOWED_EXT.has(ext)) yield full;
    }
  }
}

async function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// HTTP headers must be ASCII; percent-encode any non-ASCII characters in
// filenames / paths (Unicode-safe).
function enc(value) {
  return encodeURIComponent(value);
}

async function fetchManifest() {
  const r = await fetch(`${BRIDGE_URL}/api/library/bridge/manifest`, { headers: headersBase });
  if (!r.ok) {
    throw new Error(`Manifest fetch failed: ${r.status} ${await r.text().catch(() => "")}`);
  }
  const data = await r.json();
  const byPath = new Map();
  for (const f of data.files || []) byPath.set(f.sourcePath, f);
  return byPath;
}

// PUT a file directly to a Google Cloud Storage presigned URL.
// Streams the file via Node's https module so we never load the whole file
// into memory and we don't depend on fetch's still-evolving stream support.
function putToGcs(uploadUrl, filePath, contentType, size) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const lib = u.protocol === "http:" ? require("node:http") : require("node:https");
    const req = lib.request(
      {
        method: "PUT",
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        headers: {
          "Content-Type": contentType,
          "Content-Length": size,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            const body = Buffer.concat(chunks).toString("utf8").slice(0, 500);
            reject(new Error(`GCS PUT failed: ${res.statusCode} ${body}`));
          }
        });
      },
    );
    req.on("error", reject);
    fs.createReadStream(filePath).on("error", reject).pipe(req);
  });
}

async function uploadFile(file, sha, size) {
  const fileName = path.basename(file);
  const sourcePath = relPosix(file);

  // Step 1: ask the server for a presigned URL (or short-circuit if unchanged).
  const r1 = await fetch(`${BRIDGE_URL}/api/library/bridge/upload-url`, {
    method: "POST",
    headers: { ...headersBase, "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath, sha256: sha, size, fileName }),
  });
  if (!r1.ok) {
    throw new Error(`upload-url failed for ${sourcePath}: ${r1.status} ${await r1.text().catch(() => "")}`);
  }
  const step1 = await r1.json();
  if (step1.status === "unchanged") return step1;

  // Step 2: stream the bytes directly to Google Cloud Storage.
  await putToGcs(step1.uploadUrl, file, step1.contentType, size);

  // Step 3: tell the server we're done so it can write DB rows.
  const r3 = await fetch(`${BRIDGE_URL}/api/library/bridge/upload-complete`, {
    method: "POST",
    headers: { ...headersBase, "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath, sha256: sha, size, fileName, objectPath: step1.objectPath }),
  });
  if (!r3.ok) {
    throw new Error(`upload-complete failed for ${sourcePath}: ${r3.status} ${await r3.text().catch(() => "")}`);
  }
  return r3.json();
}

async function deleteFile(sourcePath) {
  const r = await fetch(`${BRIDGE_URL}/api/library/bridge/file`, {
    method: "DELETE",
    headers: {
      ...headersBase,
      "X-Source-Path": enc(sourcePath),
    },
  });
  if (!r.ok) {
    throw new Error(`Delete failed for ${sourcePath}: ${r.status}`);
  }
  return r.json();
}

// Local fingerprint cache so we can safely skip unchanged files without
// re-hashing every scan. Size alone is unsafe (a same-size edit would be
// missed); we require both size AND mtime to match what we last sent.
const CACHE_FILE = path.join(process.cwd(), ".bridge-cache.json");
let fingerprintCache = new Map();
try {
  if (fs.existsSync(CACHE_FILE)) {
    const obj = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    for (const [k, v] of Object.entries(obj)) fingerprintCache.set(k, v);
  }
} catch {
  fingerprintCache = new Map();
}
function saveCache() {
  try {
    const obj = Object.fromEntries(fingerprintCache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (err) {
    console.warn(`[cache] save failed: ${err.message}`);
  }
}

let scanning = false;
let pendingScan = false;

async function scan() {
  if (scanning) {
    pendingScan = true;
    return;
  }
  scanning = true;
  try {
    const start = Date.now();
    console.log(`[scan] starting at ${LIBRARY_PATH}`);
    const manifest = await fetchManifest();
    console.log(`[scan] cloud knows ${manifest.size} files`);

    const seen = new Set();
    let created = 0, updated = 0, skipped = 0, tooLarge = 0, errored = 0;

    for await (const file of walk(LIBRARY_PATH)) {
      const sourcePath = relPosix(file);
      seen.add(sourcePath);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch (err) {
        console.warn(`[scan] stat failed ${sourcePath}: ${err.message}`);
        errored++;
        continue;
      }
      if (stat.size > MAX_BYTES) {
        tooLarge++;
        continue;
      }
      const known = manifest.get(sourcePath);
      const cached = fingerprintCache.get(sourcePath);
      // Skip only when the cloud knows this file AND our local fingerprint
      // (size+mtime) matches the last successful upload. Same-size edits will
      // change mtime, so this catches them without re-hashing every file.
      if (known && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        skipped++;
        continue;
      }
      let sha;
      try {
        sha = await sha256OfFile(file);
      } catch (err) {
        console.warn(`[scan] hash failed ${sourcePath}: ${err.message}`);
        errored++;
        continue;
      }
      if (known && known.sha256 === sha) {
        // Cloud is up to date; just refresh local fingerprint cache.
        fingerprintCache.set(sourcePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha });
        skipped++;
        continue;
      }
      try {
        const result = await uploadFile(file, sha, stat.size);
        if (result.status === "created") created++;
        else if (result.status === "updated") updated++;
        else skipped++;
        fingerprintCache.set(sourcePath, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha });
      } catch (err) {
        console.error(`[scan] ${err.message}`);
        errored++;
      }
    }

    // Remove cloud entries whose local file no longer exists.
    let removed = 0;
    for (const [sourcePath] of manifest) {
      if (!seen.has(sourcePath)) {
        try {
          await deleteFile(sourcePath);
          fingerprintCache.delete(sourcePath);
          removed++;
        } catch (err) {
          console.warn(`[scan] delete failed ${sourcePath}: ${err.message}`);
        }
      }
    }
    saveCache();

    const ms = Date.now() - start;
    console.log(
      `[scan] done in ${(ms / 1000).toFixed(1)}s — created=${created} updated=${updated} removed=${removed} skipped=${skipped} tooLarge=${tooLarge} errored=${errored}`,
    );
  } catch (err) {
    console.error(`[scan] aborted: ${err.message}`);
  } finally {
    scanning = false;
    if (pendingScan) {
      pendingScan = false;
      setTimeout(scan, 1000);
    }
  }
}

let watchTimer = null;
function scheduleScanFromWatch() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    scan().catch((err) => console.error(err));
  }, 5_000);
}

await scan();

if (WATCH) {
  try {
    fs.watch(LIBRARY_PATH, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) return;
      console.log(`[watch] ${event} ${filename} — re-scan in 5s`);
      scheduleScanFromWatch();
    });
    console.log("[watch] watching for changes");
  } catch (err) {
    console.warn(`[watch] could not start watcher: ${err.message} (continuing with periodic polling)`);
  }
}

setInterval(() => {
  console.log(`[poll] periodic re-scan (every ${POLL_INTERVAL_MIN}m)`);
  scan().catch((err) => console.error(err));
}, POLL_INTERVAL_MIN * 60_000);
