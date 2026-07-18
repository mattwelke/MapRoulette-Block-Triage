const { launch, assertNoPageErrors, indexUrl, sampleDataPath, assert, assertEqual, runTest } = require("./support");

runTest("mr-lock-poll-status-ui: the panel reflects poll state, and never shows stale info", async () => {
  const { browser, page } = await launch();

  await page.route("https://maproulette.org/api/v2/challenge/**/taskMarkers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ markers: [{ id: 1, location: {}, status: 0, priority: 0, lockedBy: 999 }], overlaps: [] }),
    });
  });

  await page.goto(indexUrl());
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#mr-lock-poll-status", (el) => el.textContent)).includes("paused"),
    "should show paused before live sync is even on"
  );

  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#mr-lock-poll-status", (el) => el.textContent)).includes("paused"),
    "should still show paused with no challenge/data yet"
  );

  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", "12345");
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#mr-lock-poll-status", (el) => el.textContent)).includes("paused"),
    "should still show paused with a challenge ID but no areas loaded"
  );

  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);
  const afterLoadStatus = await page.$eval("#mr-lock-poll-status", (el) => el.textContent);
  assert(afterLoadStatus.includes("Last checked"), `expected a "Last checked" result once eligible, got: ${afterLoadStatus}`);

  await page.click("#mr-live-sync-checkbox"); // off
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("#mr-lock-poll-status", (el) => el.textContent),
    "Task lock checks paused (need live sync on, a Challenge ID, and some areas loaded).",
    "turning live sync off should immediately show paused, not a stale in-flight result"
  );

  assertNoPageErrors(page);
  await browser.close();
});
