#!/usr/bin/env node
// This app has no real build step (vanilla HTML/JS/CSS, vendored
// dependencies) - this script just assembles the files Netlify (or any
// static host) needs to serve into dist/, leaving dev-only files (tests/,
// node_modules/, this script, package.json) out.
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

const INCLUDE = [
  "index.html",
  "local.html",
  "local.js",
  "live.html",
  "live.js",
  "style.css",
  "manifest.json",
  "icons",
  "README.md",
  "vendor",
  "sample-data",
  "data",
];
// data/oakville-address-points.js is ~1.7MB (71k [lng,lat] pairs) - large
// for a static asset but well within what a static host serves fine,
// especially compressed (most gzip/brotli automatically); see README.

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const name of INCLUDE) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.warn(`build.js: skipping missing "${name}"`);
    continue;
  }
  copyRecursive(src, path.join(DIST, name));
}

// Stamps this build with a short version string and the time it ran, so a
// deployed page can show which build is live - referenced via a plain
// <script> tag (not fetch()) since that also works when someone opens the
// built files straight off disk via file://, where fetching a local JSON
// file can be blocked. Netlify sets COMMIT_REF to the exact commit being
// deployed; falling back to `git rev-parse` covers any other static host
// (or a local `npm run build`) that still has the repo's git history
// available, and "unknown" covers everything else (e.g. a tarball with no
// .git directory) rather than failing the build over a version label.
function resolveVersion() {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch (err) {
    return "unknown";
  }
}

const version = resolveVersion();
const builtAt = new Date().toISOString();
fs.writeFileSync(
  path.join(DIST, "version.js"),
  `window.__BLOCK_TRIAGE_VERSION__ = ${JSON.stringify({ version, builtAt })};\n`
);

console.log(`build.js: wrote dist/ from ${INCLUDE.join(", ")} (version ${version}, built ${builtAt})`);
