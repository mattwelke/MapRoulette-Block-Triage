const fs = require("fs");
const { launch, assertNoPageErrors, appUrl, tmpPath, assert, assertEqual, runTest } = require("./support");

function makeTask(id, status, lng, lat) {
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
                [lng + 0.0005, lat],
                [lng + 0.0005, lat + 0.0005],
                [lng, lat + 0.0005],
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
  const TOTAL = 1203; // exercises pagination (500/page) and the status-code mapping
  const allTasks = [];
  for (let i = 0; i < TOTAL; i++) {
    const status = i % 97 === 0 ? 5 : i % 53 === 0 ? 1 : 0; // sprinkle in Already_Fixed(5)/Fixed(1)
    allTasks.push(makeTask(1000 + i, status, -79.7 + (i % 40) * 0.001, 43.45 + Math.floor(i / 40) * 0.001));
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

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", String(CHALLENGE_ID));
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(200);

  await page.click("#mr-load-challenge-btn");
  await page.waitForTimeout(4000);

  assertEqual(requestedPages.length, 3, `expected 3 pages of 500 to cover ${TOTAL} tasks, got: ${JSON.stringify(requestedPages)}`);
  assert(
    (await page.$eval("#mr-load-status", (el) => el.textContent)).includes(`Loaded ${TOTAL}`),
    "load status should confirm the total loaded"
  );
  assert((await page.$eval("#file-name", (el) => el.textContent)).includes(`${TOTAL} features`), "file-name label should reflect the load");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${TOTAL}`), "stats should reflect the load");

  const lockedCount = await page.$$eval(".status-dot.locked", (els) => els.length);
  assert(lockedCount > 0, "expected some locked (Fixed/Already_Fixed) rows given the synthesized status mix");

  const downloadPath = tmpPath("mr-load-challenge-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, TOTAL, "export should carry every loaded task area");
  assert(!!exported.features[0].properties.mr_taskId, "exported features should carry mr_taskId");
  assertEqual(exported.features[0].properties.mr_challengeId, String(CHALLENGE_ID), "exported features should carry mr_challengeId");

  // Loading again with entries already present should ask for confirmation.
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
