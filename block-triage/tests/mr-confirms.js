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

runTest("mr-confirms: queueing needs no confirm, processing/splitting do", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss(); // specifically testing the decline path
  });

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "sanity: this row should be a loaded, unlocked task"
  );

  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 0, "queueing is fully reversible - no confirm should be shown");
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending removal",
    "button should reflect the queued state"
  );

  await page.click("[data-mr-action]"); // dequeue
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 0, "dequeueing is also fully reversible - still no confirm");

  await page.click("[data-mr-action]"); // re-queue
  await page.waitForTimeout(200);
  await page.click("#mr-queue-btn"); // process - should ask for one bulk confirm
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 1, "processing the queue should ask for exactly one confirm");
  assert(dialogs[0].includes("permanently delete"), `expected a deletion confirm, got: ${dialogs[0]}`);
  const queueLabelAfterDecline = await page.$eval("#mr-queue-btn", (el) => el.textContent);
  assert(queueLabelAfterDecline.includes("(1)"), `declining the confirm should leave the item queued, got: ${queueLabelAfterDecline}`);

  await page.click("[data-split]");
  await page.waitForTimeout(600); // split does a live lock recheck before the confirm - give the mocked request time
  assertEqual(dialogs.length, 2, "clicking Split on a task-linked area should ask for a second confirm");
  assert(dialogs[1].includes("Splitting it will delete"), `expected a split-sync confirm, got: ${dialogs[1]}`);
  assert(await page.$eval("#draw-status", (el) => el.hidden), "declining the split confirm should not enter draw mode");

  assertNoPageErrors(page);
  await browser.close();
});
