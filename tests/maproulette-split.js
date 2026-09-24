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

runTest("maproulette-split: split applies locally right away even when the MapRoulette sync fails", async () => {
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

  // Row #9 is the largest, unlocked, task-linked feature by design (see
  // mrChallengeSampleTasks - area increases with mr_taskId).
  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);
  assert(!!(await page.$("[data-split]")), "the feature being split should be unlocked and splittable");

  await page.click("[data-split]");
  await page.waitForTimeout(300);

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.click(mapBox.x + 20, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.click(mapBox.x + mapBox.width - 20, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // Finishing the cut applies the split locally right away - only the
  // MapRoulette sync (delete old task, create new ones) is queued.
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 11"),
    "the split should apply locally as soon as the cut finishes"
  );
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split's MapRoulette sync should be queued for processing"
  );

  // processSplitQueue deletes the original task first, then creates two new
  // ones - make that delete fail persistently (every attempt, including
  // mrRequest's own internal retries) to exercise genuine retry exhaustion
  // without depending on real network conditions.
  mrState.deleteAlwaysFailsStatus = 500;

  await page.click("#mr-split-queue-btn");
  await page.waitForTimeout(3000); // mrRequest retries a couple of times with backoff before giving up

  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 11"),
    "the local split should be unaffected by the remote sync outcome"
  );
  assert(
    mrState.deletedTaskIds.length >= 2,
    `expected more than one delete attempt (mrRequest's own retries), got: ${JSON.stringify(mrState.deletedTaskIds)}`
  );
  assertEqual(
    dialogs.length,
    0,
    `processing a queue shouldn't show a confirm anymore, and a delete failure shouldn't alert separately either - it's tracked in the orphaned-deletes queue instead; got dialogs: ${JSON.stringify(
      dialogs
    )}`
  );
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (0)",
    "the split queue should be empty after processing"
  );
  assertEqual(
    await page.$eval("#mr-orphaned-delete-queue-btn", (el) => el.textContent),
    "Process orphaned deletes (1)",
    "the original task, which never got deleted, should land in the orphaned-deletes queue"
  );

  assertNoPageErrors(page);
  await browser.close();
});
