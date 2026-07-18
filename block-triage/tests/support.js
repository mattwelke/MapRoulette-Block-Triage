// Shared helpers for the Playwright test scripts in this directory.
//
// These tests drive index.html directly as a file:// URL - there's no build
// step or dev server for this app, so that's also how you'd use it by hand.
//
// Browser launch is configurable via environment variables since the exact
// Chromium path and any outbound-proxy requirement are specific to whatever
// machine/sandbox is running the tests, not something this repo should hardcode:
//   PW_EXECUTABLE_PATH - path to a Chromium binary (falls back to Playwright's
//                        own bundled browser if unset)
//   PW_PROXY_SERVER    - e.g. "http://127.0.0.1:33007" (no proxy if unset)

const path = require("path");
const os = require("os");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const REPO_ROOT = path.join(__dirname, "..");

function indexUrl() {
  return pathToFileURL(path.join(REPO_ROOT, "index.html")).href;
}

function sampleDataPath(name) {
  return path.join(REPO_ROOT, "sample-data", name);
}

function fixturePath(name) {
  return path.join(__dirname, "fixtures", name);
}

// Scratch space for downloads/screenshots a test wants to inspect - not
// committed (see .gitignore), recreated as needed.
function tmpPath(name) {
  const dir = path.join(__dirname, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

async function launch() {
  const launchOptions = {
    args: ["--no-sandbox"],
  };
  if (process.env.PW_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PW_EXECUTABLE_PATH;
  }
  if (process.env.PW_PROXY_SERVER) {
    launchOptions.proxy = { server: process.env.PW_PROXY_SERVER };
  }
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  watchForPageErrors(page);
  return { browser, page };
}

// A JS exception during the page's own execution almost always means a real
// bug, not something a test should just log and move past - track it per
// page so runTest() can fail loudly instead of the test silently continuing.
function watchForPageErrors(page) {
  page._pageErrors = [];
  page.on("pageerror", (err) => page._pageErrors.push(err));
}

function assertNoPageErrors(page) {
  if (page._pageErrors && page._pageErrors.length > 0) {
    throw new Error(
      `Page threw ${page._pageErrors.length} JS error(s) during the test: ` +
        page._pageErrors.map((e) => e.message).join("; ")
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("Assertion failed: " + message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// Wraps a test's main async body: reports success/failure consistently and
// sets the process exit code so a runner (or plain `node some-test.js`) can
// tell pass from fail without parsing output.
function runTest(name, fn) {
  (async () => {
    console.log(`--- ${name} ---`);
    await fn();
    console.log(`PASS: ${name}`);
  })().catch((err) => {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  REPO_ROOT,
  indexUrl,
  sampleDataPath,
  fixturePath,
  tmpPath,
  launch,
  watchForPageErrors,
  assertNoPageErrors,
  assert,
  assertEqual,
  runTest,
};
