const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  runTest,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90001;

runTest("maproulette-split: local split succeeds even when the MapRoulette sync fails", async () => {
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

  // syncSplitToMapRoulette deletes the original task first, then creates two
  // new ones - fail that first delete deterministically to exercise the
  // failure path without depending on real network conditions.
  mrState.nextDeleteStatus = 500;

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
  await page.waitForTimeout(1000);

  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 11"),
    "the local split should succeed regardless of remote sync outcome"
  );

  // Give the async MapRoulette sync (delete attempt) time to run and fail.
  await page.waitForTimeout(2000);
  assert(
    dialogs.some((d) => d.toLowerCase().includes("failed")),
    `expected an alert about the failed MapRoulette sync, got dialogs: ${JSON.stringify(dialogs)}`
  );
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 11"),
    "the failed sync should not undo the local split"
  );

  assertNoPageErrors(page);
  await browser.close();
});
