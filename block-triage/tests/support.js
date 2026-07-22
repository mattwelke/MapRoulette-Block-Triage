// Shared helpers for the Playwright test scripts in this directory.
//
// These tests drive the app's HTML files directly as file:// URLs - there's
// no build step or dev server for this app, so that's also how you'd use it
// by hand. index.html itself is just the chooser page (local file triage vs.
// live MapRoulette editing); localUrl()/liveUrl() point at the two destinations.
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

function landingUrl() {
  return pathToFileURL(path.join(REPO_ROOT, "index.html")).href;
}

function localUrl() {
  return pathToFileURL(path.join(REPO_ROOT, "local.html")).href;
}

function liveUrl() {
  return pathToFileURL(path.join(REPO_ROOT, "live.html")).href;
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

// --- MapRoulette API mocking for live.html ---
//
// live.html only ever loads data via the MapRoulette API (there's no file
// upload for its working dataset), so tests that need MapRoulette-linked
// features build synthetic Task objects (the API's own shape - see
// GET /challenge/{id}/tasks) and mock the endpoints live.js calls, rather
// than loading a GeoJSON fixture file directly.

const MR_TASK_STATUS_CODES = {
  Created: 0,
  Fixed: 1,
  Not_An_Issue: 2,
  Skipped: 3,
  Deleted: 4,
  Already_Fixed: 5,
  Too_Hard: 6,
};

function makeMrTask(id, geometry, status) {
  return {
    id,
    name: `task-${id}`,
    created: 0,
    modified: 0,
    parent: null,
    geometries: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] },
    review: {},
    priority: 0,
    errorTags: "",
    skipCount: 0,
    archived: false,
    status: MR_TASK_STATUS_CODES[status || "Created"],
  };
}

// Rebuilds the classic 10-feature mr-challenge-sample.geojson fixture as
// Task objects (increasing area index 0..9, Fixed at index 3, Already_Fixed
// at index 6, mr_taskId 600001..600010) - the fixture used to be loaded via
// file-input directly; now it's turned into mocked API responses instead.
function mrChallengeSampleTasks() {
  const fc = JSON.parse(fs.readFileSync(fixturePath("mr-challenge-sample.geojson"), "utf8"));
  return fc.features.map((f) => makeMrTask(Number(f.properties.mr_taskId), f.geometry, f.properties.mr_taskStatus));
}

// Mocks GET /challenge/{id}/tasks (paginated), GET /challenge/{id}/taskMarkers
// (empty - no active locks by default), POST /task (create), and
// DELETE /task/{id} for the given challenge id. Returns a state object the
// test can inspect (state.createdTasks, state.deletedTaskIds) and mutate
// (e.g. override state.deleteStatusCode to simulate a failure).
async function routeMrChallenge(page, challengeId, tasks) {
  const state = {
    createdTasks: [],
    deletedTaskIds: [],
    nextCreatedId: 9000,
    nextDeleteStatus: null, // one-shot: fails the very next DELETE, then resets to null (so a retry after it succeeds)
    deleteAlwaysFailsStatus: null, // persistent: every DELETE fails with this status, for exercising genuine retry exhaustion
  };

  await page.route(`https://maproulette.org/api/v2/challenge/${challengeId}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit")) || tasks.length || 1;
    const pageNum = Number(url.searchParams.get("page")) || 0;
    const start = pageNum * limit;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tasks.slice(start, start + limit)) });
  });
  await page.route(`https://maproulette.org/api/v2/challenge/${challengeId}/taskMarkers**`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markers: [] }) });
  });
  await page.route("https://maproulette.org/api/v2/task", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    state.nextCreatedId++;
    let body = {};
    try {
      body = JSON.parse(route.request().postData());
    } catch (err) {
      // ignore - keep body empty
    }
    state.createdTasks.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: state.nextCreatedId }) });
  });
  await page.route(/https:\/\/maproulette\.org\/api\/v2\/task\/\d+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const m = route.request().url().match(/\/task\/(\d+)$/);
    state.deletedTaskIds.push(m ? m[1] : null);
    if (state.deleteAlwaysFailsStatus) {
      await route.fulfill({
        status: state.deleteAlwaysFailsStatus,
        contentType: "application/json",
        body: JSON.stringify({ status: "Error" }),
      });
      return;
    }
    if (state.nextDeleteStatus && state.nextDeleteStatus !== 200) {
      const status = state.nextDeleteStatus;
      state.nextDeleteStatus = null;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ status: "Error" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });

  return state;
}

// Fills in the API key + challenge ID fields on live.html and clicks "Load
// challenge from MapRoulette", waiting for the load to settle.
async function loadLiveChallenge(page, challengeId, apiKey) {
  await page.fill("#mr-api-key-input", apiKey || "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", String(challengeId));
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(200);
  await page.click("#mr-load-challenge-btn");
  await page.waitForTimeout(1500);
}

async function launch(opts) {
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
  const viewport = (opts && opts.viewport) || { width: 1400, height: 900 };
  const page = await browser.newPage({ viewport });
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

// Checks actual rendered visibility (computed display), not just the
// `hidden` DOM property - a CSS rule with display:flex/block can silently
// override the browser's default [hidden]{display:none} and the property
// alone won't catch that.
async function assertRenderedVisibility(page, selector, expectedVisible, message) {
  const isVisible = await page.$eval(selector, (el) => getComputedStyle(el).display !== "none");
  if (isVisible !== expectedVisible) {
    throw new Error(`Assertion failed: ${message} (expected rendered-visible=${expectedVisible}, got ${isVisible})`);
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
  landingUrl,
  localUrl,
  liveUrl,
  sampleDataPath,
  fixturePath,
  tmpPath,
  launch,
  watchForPageErrors,
  assertNoPageErrors,
  assert,
  assertEqual,
  assertRenderedVisibility,
  runTest,
  makeMrTask,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
};
