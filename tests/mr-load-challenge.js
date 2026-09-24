const { launch, assertNoPageErrors, liveUrl, assert, assertEqual, runTest } = require("./support");

function makeTask(id, status, lng, lat, size) {
  size = size || 0.0005;
  return {
    id,
    name: `task-${id}`,
    created: 0,
    modified: 0,
    parent: 55881,
    geometries: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [lng, lat],
                [lng + size, lat],
                [lng + size, lat + size],
                [lng, lat + size],
                [lng, lat],
              ],
            ],
          },
        },
      ],
    },
    review: {},
    priority: 0,
    errorTags: "",
    skipCount: 0,
    archived: false,
    status,
  };
}

runTest("mr-load-challenge: pull a challenge straight from the API, no file upload", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const CHALLENGE_ID = 55881;
  const TOTAL = 5001; // exercises pagination (5000/page) and the status-code mapping
  const allTasks = [];
  for (let i = 0; i < TOTAL; i++) {
    const status = i % 97 === 0 ? 5 : i % 53 === 0 ? 1 : 0; // sprinkle in Already_Fixed(5)/Fixed(1)
    // Task 0 (locked) gets a deliberately tiny area so it always sorts first
    // ("sorted by area, smallest first") and lands in the virtualized list's
    // initially-rendered window below, regardless of how many other tasks
    // (with the default, much larger size) it's competing with.
    const size = i === 0 ? 0.00001 : 0.0005;
    allTasks.push(makeTask(1000 + i, status, -79.7 + (i % 40) * 0.001, 43.45 + Math.floor(i / 40) * 0.001, size));
  }

  const requestedPages = [];
  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit"));
    const pageNum = Number(url.searchParams.get("page"));
    requestedPages.push({ limit, pageNum });
    const start = pageNum * limit;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(allTasks.slice(start, start + limit)) });
  });
  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/taskMarkers**`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markers: [] }) });
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", String(CHALLENGE_ID));
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(200);

  await page.click("#mr-load-challenge-btn");
  await page.waitForTimeout(6000);

  assertEqual(requestedPages.length, 2, `expected 2 pages of 5000 to cover ${TOTAL} tasks, got: ${JSON.stringify(requestedPages)}`);
  assert(
    (await page.$eval("#mr-load-status", (el) => el.textContent)).includes(`Loaded ${TOTAL}`),
    "load status should confirm the total loaded"
  );
  assert((await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${TOTAL}`), "stats should reflect the load");
  assert(
    (await page.$eval("#mr-live-banner-challenge", (el) => el.textContent)).includes(String(CHALLENGE_ID)),
    "the live banner should reflect the loaded challenge ID"
  );

  const lockedCount = await page.$$eval(".status-dot.locked", (els) => els.length);
  assert(lockedCount > 0, "expected some locked (Fixed/Already_Fixed) rows given the synthesized status mix");

  // Loading again with entries already present should ask for confirmation.
  // The setup fields (including this button) auto-collapse once a challenge
  // loads, so re-expand them first to reach it, same as a real user would.
  await page.click("#mr-setup-toggle-btn");
  const dialogMessages = [];
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept();
  });
  await page.click("#mr-load-challenge-btn");
  await page.waitForTimeout(3000);
  assert(dialogMessages.length > 0, "reloading the challenge with existing areas on screen should confirm first");

  assertNoPageErrors(page);
  await browser.close();
});
