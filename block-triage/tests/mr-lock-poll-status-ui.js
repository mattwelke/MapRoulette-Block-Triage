const { launch, assertNoPageErrors, liveUrl, sampleDataPath, assert, assertEqual, runTest } = require("./support");

const CHALLENGE_ID = 12345;

runTest("mr-lock-poll-status-ui: the panel reflects poll state, and never shows stale info", async () => {
  const { browser, page } = await launch();

  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/taskMarkers**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ markers: [{ id: 1, location: {}, status: 0, priority: 0, lockedBy: 999 }], overlaps: [] }),
    });
  });
  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const pageNum = Number(url.searchParams.get("page")) || 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        pageNum === 0
          ? [
              {
                id: 501,
                name: "task-501",
                created: 0,
                modified: 0,
                parent: CHALLENGE_ID,
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
                            [-79.7, 43.45],
                            [-79.6995, 43.45],
                            [-79.6995, 43.4505],
                            [-79.7, 43.4505],
                            [-79.7, 43.45],
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
                status: 0,
              },
            ]
          : []
      ),
    });
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#mr-lock-poll-status", (el) => el.textContent)).includes("paused"),
    "should show paused before any challenge/data is loaded"
  );

  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", String(CHALLENGE_ID));
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#mr-lock-poll-status", (el) => el.textContent)).includes("paused"),
    "should still show paused with a challenge ID but no areas loaded yet"
  );

  await page.click("#mr-load-challenge-btn");
  await page.waitForTimeout(1500);
  const afterLoadStatus = await page.$eval("#mr-lock-poll-status", (el) => el.textContent);
  assert(afterLoadStatus.includes("Last checked"), `expected a "Last checked" result once eligible, got: ${afterLoadStatus}`);

  // Clearing the Challenge ID makes lock polling ineligible again - this
  // should show up immediately, not leave a stale "Last checked" result.
  await page.fill("#mr-challenge-id-input", "");
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("#mr-lock-poll-status", (el) => el.textContent),
    "Task lock checks paused (need a Challenge ID and some areas loaded).",
    "clearing the Challenge ID should immediately show paused, not a stale in-flight result"
  );

  assertNoPageErrors(page);
  await browser.close();
});
