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

runTest("mr-failed-retry: a failed delete drops the queued styling and stays retryable", async () => {
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

  mrState.nextDeleteStatus = 500;
  await page.click("#mr-queue-btn"); // process (will fail once)
  await page.waitForTimeout(2000);

  const freshRows = await page.$$(".feature-row");
  const rowClass = await freshRows[freshRows.length - 1].getAttribute("class");
  assert(!rowClass.includes("mr-delete-queued"), `failed item should drop the queued styling, got class: ${rowClass}`);

  await freshRows[freshRows.length - 1].click();
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "the failed item should still be linked and ready to retry"
  );

  assertNoPageErrors(page);
  await browser.close();
});
