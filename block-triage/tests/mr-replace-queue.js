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

runTest("mr-replace-queue: select areas to replace, draw replacements, queue and process the swap", async () => {
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

  const totalBefore = await page.$eval("#stats", (el) => el.textContent);
  assert(totalBefore.includes("Total: 10"), `sanity: expected 10 loaded tasks, got: ${totalBefore}`);

  await page.click("#replace-area-btn");
  await page.waitForTimeout(200);
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "starting Replace should show the draw-status bar");

  // Row #9 is the largest, unlocked, task-linked feature by design.
  const row9 = await findRowByIdx(page, 9);
  await row9.click();
  await page.waitForTimeout(200);
  const row9Again = await findRowByIdx(page, 9); // renderList() rebuilt the list DOM
  assert(
    (await row9Again.evaluate((el) => el.classList.contains("replace-selected"))),
    "clicking a row while selecting for replace should mark it selected"
  );

  await page.keyboard.press("Enter"); // finish selecting
  await page.waitForTimeout(300);

  // The original should now be gone from the map/list.
  const rowAfterSelect = await findRowByIdx(page, 9);
  assert(rowAfterSelect === null, "the selected original should disappear once selection finishes");
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 9"),
    "the original should be removed locally right after finishing selection"
  );

  // Draw one replacement area.
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

  // Still mid-replace (drawing phase) - the drawn area is visible but not
  // yet queued, and the status bar should still be showing.
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "the replace status bar should stay visible after drawing one area");
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"),
    "the drawn replacement should already be visible locally"
  );
  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (0)",
    "nothing should be queued until Finish replacing"
  );

  await page.keyboard.press("Enter"); // finish replacing
  await page.waitForTimeout(300);

  assert(await page.$eval("#draw-status", (el) => el.hidden), "the draw-status bar should hide once replacing finishes");
  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (1)",
    "finishing should queue exactly one replace group"
  );

  const replacementRow = await findRowByIdx(page, "replace-1");
  assert(!!replacementRow, "expected the drawn replacement in the list, tagged replace-1");
  assert(
    (await replacementRow.evaluate((el) => el.classList.contains("mr-replace-queued"))),
    "the queued replacement's row should show as replace-queued"
  );

  // The replacement should be off-limits to other structural actions while pending.
  await replacementRow.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-split]")) === null, "a replace-pending area's popup should not offer Split");
  assert((await page.$("[data-mr-action]")) === null, "a replace-pending area's popup should not offer the add/remove action");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Process the replace queue: the original's task should get deleted, and
  // a new task created for the replacement.
  await page.click("#mr-replace-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(dialogs.length, 1, `expected exactly one confirm for processing the replace queue, got: ${JSON.stringify(dialogs)}`);
  assertEqual(mrState.deletedTaskIds.length, 1, "expected exactly 1 delete request (for row #9's old task)");
  assertEqual(mrState.createdTasks.length, 1, "expected exactly 1 create request (for the drawn replacement)");
  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (0)",
    "the replace queue should be empty after processing"
  );

  const replacementRowAfter = await findRowByIdx(page, "replace-1");
  assert(
    !(await replacementRowAfter.evaluate((el) => el.classList.contains("mr-replace-queued"))),
    "the replacement should no longer show as replace-queued once processed"
  );
  await replacementRowAfter.click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "the processed replacement should now be linked to its new task"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mr-replace-queue: canceling at either phase backs out cleanly, and undo reverses a finished replace", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Cancel during the "selecting" phase - nothing should change at all.
  await page.click("#replace-area-btn");
  await page.waitForTimeout(150);
  const row9 = await findRowByIdx(page, 9);
  await row9.click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  assert(await page.$eval("#draw-status", (el) => el.hidden), "Escape during selecting should hide the status bar");
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"),
    "canceling during selecting should not remove anything"
  );
  assert(await page.$eval("#undo-btn", (el) => el.disabled), "canceling during selecting should not push an undo action");

  // Cancel during the "drawing" phase - the original(s) should come back,
  // and any replacement drawn so far should be dropped.
  await page.click("#replace-area-btn");
  await page.waitForTimeout(150);
  const row9Again = await findRowByIdx(page, 9);
  await row9Again.click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter"); // finish selecting
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 9"),
    "the original should be gone once selection finishes"
  );

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
  await page.keyboard.press("Enter"); // finish drawing this one replacement
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"),
    "the drawn replacement should be visible before canceling"
  );

  await page.keyboard.press("Escape"); // cancel the whole replace
  await page.waitForTimeout(200);
  assert(await page.$eval("#draw-status", (el) => el.hidden), "Escape during drawing should hide the status bar");
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"),
    "canceling during drawing should restore the original and drop the drawn replacement"
  );
  const row9Restored = await findRowByIdx(page, 9);
  assert(!!row9Restored, "the original area should be back after canceling mid-replace");
  const replacementRow = await findRowByIdx(page, "replace-1");
  assert(replacementRow === null, "the drawn-but-not-finished replacement should be gone after canceling");
  assert(await page.$eval("#undo-btn", (el) => el.disabled), "canceling during drawing should not push an undo action");
  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (0)",
    "canceling before Finish replacing should queue nothing"
  );

  // Now actually finish a replace, then undo it.
  await page.click("#replace-area-btn");
  await page.waitForTimeout(150);
  const row9ForReal = await findRowByIdx(page, 9);
  await row9ForReal.click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter"); // finish selecting
  await page.waitForTimeout(200);
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
  await page.keyboard.press("Enter"); // finish drawing
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter"); // finish replacing
  await page.waitForTimeout(200);

  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (1)",
    "finishing should queue the replace group"
  );
  assert(!(await page.$eval("#undo-btn", (el) => el.disabled)), "finishing a replace should push one undo action");

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"),
    "undo should restore the original and remove the replacement"
  );
  assert(!!(await findRowByIdx(page, 9)), "undo should bring row #9 back");
  assert((await findRowByIdx(page, "replace-1")) === null, "undo should remove the drawn replacement");
  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (0)",
    "undo should also drop the group from the replace queue"
  );

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"),
    "redo should reapply the replace"
  );
  assert((await findRowByIdx(page, 9)) === null, "redo should remove row #9 again");
  assert(!!(await findRowByIdx(page, "replace-1")), "redo should bring the replacement back");
  assertEqual(
    await page.$eval("#mr-replace-queue-btn", (el) => el.textContent),
    "Process replace queue (1)",
    "redo should re-queue the replace group"
  );

  assertNoPageErrors(page);
  await browser.close();
});
