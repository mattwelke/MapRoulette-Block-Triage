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

async function findRowByIdx(page, idx) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label === `#${idx}`) return row;
  }
  return null;
}

runTest("mr-confirms: queueing and processing a queue (including a split) both start immediately, no confirm dialog", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Row #0 is unlocked and task-linked - used for the delete-queue half of
  // this test since it isn't needed afterward.
  const row0 = await findRowByIdx(page, 0);
  await row0.click();
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
  await page.click("#mr-queue-btn"); // process - should start right away, no confirm
  await page.waitForTimeout(1000);
  assertEqual(dialogs.length, 0, "processing the delete queue should start immediately with no confirm dialog");
  assertEqual(mrState.deletedTaskIds.length, 1, "the queued task should actually have been deleted");
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "the delete queue should be empty once processing finishes"
  );
  assert((await findRowByIdx(page, 0)) === null, "row #0 should be gone - the delete actually went through");

  // Row #9 is the largest, unlocked, task-linked feature by design (see
  // mrChallengeSampleTasks - area increases with mr_taskId) - used for the
  // split half of this test since a full-width cut reliably bisects it.
  const row9 = await findRowByIdx(page, 9);
  await row9.click();
  await page.waitForTimeout(300);
  await page.click("[data-split]");
  await page.waitForTimeout(600); // split does a live lock recheck before entering draw mode - give the mocked request time
  assertEqual(dialogs.length, 0, "clicking Split should enter draw mode directly - no confirm at all");
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "clicking Split should enter draw mode");

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const midY = mapBox.y + mapBox.height / 2;
  await page.mouse.click(mapBox.x + 5, midY);
  await page.waitForTimeout(150);
  await page.mouse.click(mapBox.x + mapBox.width - 5, midY);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  assertEqual(dialogs.length, 0, "finishing the cut should just queue the split - still no confirm");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split should be queued for processing"
  );

  await page.click("#mr-split-queue-btn");
  await page.waitForTimeout(1500);
  assertEqual(dialogs.length, 0, "processing the split queue should also start immediately with no confirm dialog");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (0)",
    "the split queue should be empty once processing finishes"
  );

  assertNoPageErrors(page);
  await browser.close();
});
