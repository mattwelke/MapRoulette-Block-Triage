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

const CHALLENGE_ID = 91002;

async function findRowByIdx(page, idx) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label === `#${idx}`) return row;
  }
  return null;
}

runTest("mr-process-all: one button processes every queue type at once", async () => {
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

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (0)",
    "process-all button should start at 0 with nothing queued"
  );
  assert(await page.$eval("#mr-process-all-btn", (el) => el.disabled), "process-all button should be disabled with nothing queued");

  // Queue row #9 (largest, unlocked, task-linked) for deletion.
  const row9 = await findRowByIdx(page, 9);
  await row9.click();
  await page.waitForTimeout(200);
  await page.click("[data-mr-action]");
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (1)",
    "sanity: one item should be queued for deletion"
  );

  // Draw a brand new area - auto-queued for adding.
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const base = { x: mapBox.x + mapBox.width / 2 - 250, y: mapBox.y + mapBox.height / 2 - 150 };
  await page.click("#add-area-btn");
  await page.waitForTimeout(150);
  for (const p of [
    { x: base.x, y: base.y },
    { x: base.x + 60, y: base.y },
    { x: base.x + 30, y: base.y + 60 },
  ]) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (1)",
    "sanity: one item should be queued for adding"
  );

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (2)",
    "process-all button should reflect the combined total across queues"
  );
  assert(!(await page.$eval("#mr-process-all-btn", (el) => el.disabled)), "process-all button should be enabled once something is queued");

  await page.click("#mr-process-all-btn");
  await page.waitForTimeout(2000);

  // Only the delete queue should have needed a confirm - adding isn't destructive.
  assertEqual(dialogs.length, 1, `expected exactly one confirm (for the delete queue), got: ${JSON.stringify(dialogs)}`);
  assert(dialogs[0].includes("permanently delete"), `expected a deletion confirm, got: ${dialogs[0]}`);

  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (0)",
    "the add queue should be empty after Process all pending"
  );
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "the delete queue should be empty after Process all pending"
  );
  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (0)",
    "the combined total should be back to 0"
  );
  assertEqual(mrState.deletedTaskIds.length, 1, "expected exactly 1 delete request to have gone out");
  assertEqual(mrState.createdTasks.length, 1, "expected exactly 1 create request to have gone out");

  assertNoPageErrors(page);
  await browser.close();
});
