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

runTest("mr-sequential-queue: processing a queue never has more than one MapRoulette request in flight at once", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  // 5 well-separated, unlocked, task-linked areas - enough that overlapping
  // requests would be obvious if they happened.
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(makeMrTask(800001 + i, square(-79.9 + i * 0.02, 43.45, 0.001), "Created"));
  }
  await routeMrChallenge(page, CHALLENGE_ID, tasks);

  // Every DELETE takes a deliberate 300ms to resolve and tracks how many are
  // concurrently in flight - long enough to reliably catch an overlap if the
  // app ever issues two at once, without depending on any internal
  // concurrency-tracking hook in the app.
  let inFlight = 0;
  let maxObservedInFlight = 0;
  await page.route(/https:\/\/maproulette\.org\/api\/v2\/task\/\d+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    inFlight++;
    maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 300));
    inFlight--;
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
  await page.waitForTimeout(2500); // let the whole batch finish (5 * 300ms sequential + overhead)

  assertEqual(maxObservedInFlight, 1, `expected at most 1 request in flight at any point, observed a peak of ${maxObservedInFlight}`);
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "the delete queue should be empty once every deletion completes"
  );
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 0"), "all 5 tasks should be deleted");

  assertNoPageErrors(page);
  await browser.close();
});
