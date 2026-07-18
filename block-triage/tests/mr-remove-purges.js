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

runTest("mr-remove-purges: a successfully-deleted task disappears from map/list/stats", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"), "expected 10 features loaded");

  const rows = await page.$$(".feature-row");
  const targetLabel = await rows[rows.length - 1].$eval(".id", (el) => el.textContent);
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);

  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.click("#mr-queue-btn"); // process
  await page.waitForTimeout(1500);

  assertEqual(mrState.deletedTaskIds.length, 1, "expected exactly 1 delete request");
  assertEqual(mrState.deletedTaskIds[0], "600010", `expected task 600010 to be deleted, got: ${mrState.deletedTaskIds[0]}`);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 9"), "Total should drop by 1 after a successful delete");
  assert((await page.$(".leaflet-popup")) === null, "popup should be closed after removal");

  const stillPresent = await page.$$eval(".feature-row .id", (els, label) => els.some((e) => e.textContent === label), targetLabel);
  assert(!stillPresent, "the removed feature's row should no longer be in the sidebar list");

  assertNoPageErrors(page);
  await browser.close();
});
