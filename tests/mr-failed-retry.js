const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90001;

runTest("mr-failed-retry: a transient delete failure is retried automatically and still succeeds", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(200);
  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});

  mrState.nextDeleteStatus = 500; // fails only the very next DELETE, then resets - a transient blip
  await page.click("#mr-queue-btn"); // process
  await page.waitForTimeout(3000); // mrRequest retries with backoff before this settles

  assert(
    mrState.deletedTaskIds.length >= 2,
    `expected the failed attempt plus at least one retry, got: ${JSON.stringify(mrState.deletedTaskIds)}`
  );
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 9"),
    "the task should end up genuinely deleted once the retry succeeds"
  );
  assertEqual(
    await page.$eval("#mr-queue-status", (el) => el.textContent),
    "Done — deleted 1 task.",
    "a transient failure recovered by retrying shouldn't be reported as a failure at all"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mr-failed-retry: a persistent delete failure exhausts retries and stays queued", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(200);
  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});

  mrState.deleteAlwaysFailsStatus = 500; // every attempt fails, including mrRequest's own retries
  await page.click("#mr-queue-btn"); // process (will exhaust retries and fail)
  await page.waitForTimeout(3000);

  assert(
    mrState.deletedTaskIds.length >= 2,
    `expected multiple delete attempts before giving up, got: ${JSON.stringify(mrState.deletedTaskIds)}`
  );

  const freshRows = await page.$$(".feature-row");
  const rowClass = await freshRows[freshRows.length - 1].getAttribute("class");
  assert(rowClass.includes("mr-delete-queued"), `a failed item should stay queued to retry, got class: ${rowClass}`);
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (1)",
    "the failed item should still be counted in the delete queue for next time"
  );
  assert(
    (await page.$eval("#mr-queue-status", (el) => el.textContent)).includes("still queued to retry"),
    "the status message should point at retrying next time, not a manual re-click"
  );

  await freshRows[freshRows.length - 1].click();
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending removal",
    "the failed item should still be linked and still show as queued for removal"
  );

  assertNoPageErrors(page);
  await browser.close();
});
