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

// Splits whichever single feature row is currently showing #idx by drawing
// a horizontal line across the map.
async function splitRow(page, idx) {
  const row = await findRowByIdx(page, idx);
  await row.click();
  await page.waitForTimeout(300);
  await page.click("[data-split]");
  await page.waitForTimeout(300);

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
}

runTest("mr-split-in-group: splitting a piece of a pending split folds into the same group", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Row #9 is the largest, unlocked, task-linked feature by design.
  await splitRow(page, 9);
  assert(!!(await findRowByIdx(page, "9a")) && !!(await findRowByIdx(page, "9b")), "expected the first split's two pieces");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "one group should be pending after the first split"
  );

  // Split piece 9a again - a nested split of a pending piece.
  await splitRow(page, "9a");

  assert((await findRowByIdx(page, "9a")) === null, "9a should be gone once it's split further");
  const row9aa = await findRowByIdx(page, "9aa");
  const row9ab = await findRowByIdx(page, "9ab");
  const row9b = await findRowByIdx(page, "9b");
  assert(!!row9aa && !!row9ab, "expected 9a's own two pieces (9aa, 9ab)");
  assert(!!row9b, "9b (from the first split) should still be there, untouched");

  // Still just ONE group pending - the nested split folded into it rather
  // than creating a second group.
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the nested split should still be just one pending group"
  );
  assert(await row9aa.evaluate((el) => el.classList.contains("mr-split-queued")), "9aa should show as split-queued");
  assert(await row9ab.evaluate((el) => el.classList.contains("mr-split-queued")), "9ab should show as split-queued");
  assert(await row9b.evaluate((el) => el.classList.contains("mr-split-queued")), "9b should still show as split-queued");

  // Process the queue: the root task (600010, per mrChallengeSampleTasks -
  // task ids increase with idx and row #9 is the 10th feature) should be
  // deleted once, and three new tasks created (9aa, 9ab, 9b) - not two.
  await page.click("#mr-split-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(mrState.deletedTaskIds.length, 1, `expected exactly 1 deleted task (the root), got: ${JSON.stringify(mrState.deletedTaskIds)}`);
  assertEqual(mrState.createdTasks.length, 3, `expected exactly 3 created tasks (9aa, 9ab, 9b), got ${mrState.createdTasks.length}`);
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (0)",
    "the split queue should be empty after processing"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mr-split-in-group: undo/redo unwind a nested split independently of the outer split", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await splitRow(page, 9);
  await splitRow(page, "9a");

  assert(!!(await findRowByIdx(page, "9aa")) && !!(await findRowByIdx(page, "9ab")), "expected the nested split's pieces");
  assert(!!(await findRowByIdx(page, "9b")), "expected the outer split's untouched other piece");

  // First undo should only unwind the NESTED split (9aa/9ab -> back to 9a),
  // leaving the outer split (9b, and the group) alone.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  assert((await findRowByIdx(page, "9aa")) === null && (await findRowByIdx(page, "9ab")) === null, "nested pieces should be gone");
  assert(!!(await findRowByIdx(page, "9a")), "9a should be back after undoing just the nested split");
  assert(!!(await findRowByIdx(page, "9b")), "9b should be untouched by undoing the nested split");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the outer group should still be pending after undoing only the nested split"
  );

  // Second undo now unwinds the OUTER split entirely.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  assert(!!(await findRowByIdx(page, 9)), "row #9 should be fully restored");
  assert((await findRowByIdx(page, "9a")) === null && (await findRowByIdx(page, "9b")) === null, "both outer pieces should be gone");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (0)",
    "the split queue should be empty once the outer split is undone"
  );

  // Redo replays both steps in the same order: outer split first, then the
  // nested split.
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(200);
  assert(!!(await findRowByIdx(page, "9a")) && !!(await findRowByIdx(page, "9b")), "redo should reapply the outer split");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(200);
  assert(!!(await findRowByIdx(page, "9aa")) && !!(await findRowByIdx(page, "9ab")), "redo should reapply the nested split");
  assert(!!(await findRowByIdx(page, "9b")), "9b should still be there after redoing the nested split");

  assertNoPageErrors(page);
  await browser.close();
});
