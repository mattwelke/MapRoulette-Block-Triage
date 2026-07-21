#!/usr/bin/env node
// This app has no real build step (vanilla HTML/JS/CSS, vendored
// dependencies) - this script just assembles the files Netlify (or any
// static host) needs to serve into dist/, leaving dev-only files (tests/,
// node_modules/, this script, package.json) out.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

const INCLUDE = [
  "index.html",
  "local.html",
  "local.js",
  "live.html",
  "live.js",
  "style.css",
  "theme.js",
  "manifest.json",
  "icons",
  "README.md",
  "vendor",
  "sample-data",
];

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

console.log(`build.js: wrote dist/ from ${INCLUDE.join(", ")}`);
