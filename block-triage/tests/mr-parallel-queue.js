const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90501;

function square(lng, lat, size) {
  return {
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
  };
}

runTest("mr-parallel-queue: processing a queue actually runs requests concurrently, bounded by max-concurrent", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  // 5 well-separated, unlocked, task-linked areas - more than the default
  // max-concurrent (3), so the cap itself gets exercised.
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(makeMrTask(800001 + i, square(-79.9 + i * 0.02, 43.45, 0.001), "Created"));
  }
  await routeMrChallenge(page, CHALLENGE_ID, tasks);

  // Every DELETE takes a deliberate 600ms to resolve, long enough to
  // reliably observe several in flight at once rather than racing a real
  // instant response.
  await page.route(/https:\/\/maproulette\.org\/api\/v2\/task\/\d+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 5"), "expected all 5 tasks to load");

  // Queue every area for removal via its popup - queuing doesn't remove a
  // row from the list (only actually processing the queue does), so each
  // index still points at a distinct, still-present area.
  for (let i = 0; i < 5; i++) {
    const rows = await page.$$(".feature-row");
    await rows[i].click();
    await page.waitForTimeout(150);
    await page.click("[data-mr-action]");
    await page.waitForTimeout(150);
    await page.click(".leaflet-popup-close-button").catch(() => {});
    await page.waitForTimeout(100);
  }
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (5)",
    "expected all 5 areas queued for deletion"
  );

  await page.click("#mr-queue-btn");
  await page.waitForTimeout(250); // well inside the 600ms delay window, after requests have had time to start

  const activeDuringProcessing = await page.evaluate(() => window.__blockTriageMrSlotTest.getActive());
  assert(
    activeDuringProcessing > 1,
    `expected more than 1 request in flight at once while processing (real concurrency), got active=${activeDuringProcessing}`
  );
  assert(
    activeDuringProcessing <= 3,
    `expected active requests to stay within the default max-concurrent of 3, got active=${activeDuringProcessing}`
  );

  await page.waitForTimeout(2000); // let the whole batch finish
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "the delete queue should be empty once every deletion completes"
  );
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 0"), "all 5 tasks should be deleted");

  assertNoPageErrors(page);
  await browser.close();
});
