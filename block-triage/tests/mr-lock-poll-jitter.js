const { launch, assertNoPageErrors, indexUrl, sampleDataPath, assert, runTest } = require("./support");

runTest("mr-lock-poll-jitter: the background poll interval varies, not a fixed 60000ms", async () => {
  const { browser, page } = await launch();

  // Record every setTimeout delay used anywhere in the app, before app.js
  // runs, so we can inspect what scheduleMrLockPoll actually passed in.
  await page.addInitScript(() => {
    window.__delays = [];
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function (fn, delay, ...args) {
      window.__delays.push(delay);
      return origSetTimeout(fn, delay, ...args);
    };
  });

  await page.route("https://maproulette.org/api/v2/user/whoami", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 1, osmProfile: {} }) });
  });
  await page.route("https://maproulette.org/api/v2/challenge/**/taskMarkers", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markers: [], overlaps: [] }) });
  });

  await page.goto(indexUrl());
  await page.waitForTimeout(300);
  await page.click("#mr-live-sync-checkbox");
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", "77001");
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(1500);

  // Toggling live sync off/on repeatedly re-triggers kickMrLockPoll -> scheduleMrLockPoll
  // each time, so we can collect several independent samples of the delay chosen.
  for (let i = 0; i < 6; i++) {
    await page.click("#mr-live-sync-checkbox"); // off
    await page.waitForTimeout(50);
    await page.click("#mr-live-sync-checkbox"); // back on
    await page.waitForTimeout(150);
  }

  const delays = await page.evaluate(() => window.__delays);
  const lockPollDelays = delays.filter((d) => d >= 55000 && d <= 65000);
  const uniqueValues = new Set(lockPollDelays);

  assert(lockPollDelays.length > 0, "expected at least one lock-poll-range delay to have been recorded");
  assert(
    uniqueValues.size > 1,
    `expected multiple distinct delay values (proving jitter, not a fixed 60000ms), got: ${JSON.stringify(lockPollDelays)}`
  );
  assert(
    lockPollDelays.every((d) => d >= 55000 && d <= 65000),
    `all delays should stay within the documented +/-5s window of 60000ms, got: ${JSON.stringify(lockPollDelays)}`
  );

  assertNoPageErrors(page);
  await browser.close();
});
