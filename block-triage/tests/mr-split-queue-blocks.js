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

async function doSplit(page) {
  const row = await findRowByIdx(page, 9);
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

runTest("mr-split-queue-blocks: split pieces apply locally, block other actions, and support dropping one", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await doSplit(page);

  // The split should apply locally right away: row #9 is gone, its two
  // pieces (9a/9b) are visible, and the group is queued for sync.
  assert((await findRowByIdx(page, 9)) === null, "the original row should be gone once the split applies");
  const row9a = await findRowByIdx(page, "9a");
  const row9b = await findRowByIdx(page, "9b");
  assert(!!row9a && !!row9b, "expected both split pieces (9a, 9b) in the list");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split's MapRoulette sync should be queued"
  );
  assert(await row9a.evaluate((el) => el.classList.contains("mr-split-queued")), "piece 9a should show as split-queued");
  assert(await row9b.evaluate((el) => el.classList.contains("mr-split-queued")), "piece 9b should show as split-queued");

  // A pending piece's popup should offer only "Drop this piece" - no
  // Split, Edit boundary, or remove/add action.
  await row9a.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-split]")) === null, "a pending piece's popup should not offer Split");
  assert((await page.$("[data-edit-boundary]")) === null, "a pending piece's popup should not offer Edit boundary");
  assert((await page.$("[data-mr-action]")) === null, "a pending piece's popup should not offer the add/remove action");
  assert((await page.$("[data-drop-split-piece]")) !== null, "a pending piece's popup should offer Drop this piece");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Quick queue-delete mode should also refuse to touch a pending piece.
  await page.click("#mr-quick-queue-checkbox");
  await page.waitForTimeout(150);
  const row9aAgain = await findRowByIdx(page, "9a");
  await row9aAgain.click(); // pan/select via sidebar (always opens popup regardless of quick mode)
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);
  const mapCenter = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const preQueueDialogCount = dialogs.length;
  await page.mouse.click(mapCenter.x, mapCenter.y);
  await page.waitForTimeout(300);
  assert(dialogs.length > preQueueDialogCount, "quick-queue map click on a pending piece should alert, not queue");
  assert(
    dialogs[dialogs.length - 1].includes("queued for a pending split"),
    `expected an alert explaining the pending split blocks quick queue-delete, got: ${dialogs[dialogs.length - 1]}`
  );
  await page.click("#mr-quick-queue-checkbox"); // toggle back off
  await page.waitForTimeout(150);

  // Drop piece 9b - it should disappear, 9a should remain (still pending,
  // the group is still queued since 9a is still standing).
  const row9bAgain = await findRowByIdx(page, "9b");
  await row9bAgain.click();
  await page.waitForTimeout(300);
  await page.click("[data-drop-split-piece]");
  await page.waitForTimeout(200);

  assert((await findRowByIdx(page, "9b")) === null, "the dropped piece should disappear");
  assert(!!(await findRowByIdx(page, "9a")), "the other piece should remain");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split group should still be queued with its one remaining piece"
  );

  // Dropping the last remaining piece should be refused.
  const row9aLast = await findRowByIdx(page, "9a");
  await row9aLast.click();
  await page.waitForTimeout(300);
  const dialogsBeforeLastDrop = dialogs.length;
  await page.click("[data-drop-split-piece]");
  await page.waitForTimeout(200);
  assert(dialogs.length > dialogsBeforeLastDrop, "dropping the last piece should alert instead of dropping it");
  assert(
    dialogs[dialogs.length - 1].includes("At least one piece must remain"),
    `expected a "must remain" alert, got: ${dialogs[dialogs.length - 1]}`
  );
  assert(!!(await findRowByIdx(page, "9a")), "the last piece should still be there after the refused drop");

  // Undo should bring 9b back (undoing the drop, not the whole split).
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  assert(!!(await findRowByIdx(page, "9a")), "9a should still be present after undoing the drop");
  assert(!!(await findRowByIdx(page, "9b")), "undo should bring 9b back");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split group should still show as one pending group after undoing the drop"
  );

  // Undo again should now undo the whole split - back to a single row #9.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  assert(!!(await findRowByIdx(page, 9)), "undoing the split itself should restore row #9");
  assert((await findRowByIdx(page, "9a")) === null, "9a should be gone after undoing the split");
  assert((await findRowByIdx(page, "9b")) === null, "9b should be gone after undoing the split");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (0)",
    "the split queue should be empty after undoing the split"
  );

  // Redo should reapply the split, then redo again should reapply the drop.
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(200);
  assert((await findRowByIdx(page, 9)) === null, "redo should remove row #9 again");
  assert(!!(await findRowByIdx(page, "9a")) && !!(await findRowByIdx(page, "9b")), "redo should bring both pieces back");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(200);
  assert(!!(await findRowByIdx(page, "9a")), "9a should remain after redoing the drop");
  assert((await findRowByIdx(page, "9b")) === null, "redo should drop 9b again");

  assertNoPageErrors(page);
  await browser.close();
});
