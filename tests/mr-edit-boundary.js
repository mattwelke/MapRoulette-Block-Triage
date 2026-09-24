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

const CHALLENGE_ID = 93001;

async function findRowByIdx(page, idx) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label === `#${idx}`) return row;
  }
  return null;
}

runTest("mr-edit-boundary: drag vertices to reshape a linked area, queued for MapRoulette sync", async () => {
  const { browser, page } = await launch();
  try {
    await runBody(page);
  } finally {
    await browser.close();
  }
});

async function runBody(page) {
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Row #3 is Fixed (locked) by fixture design - its popup should not offer
  // Edit boundary at all.
  const lockedRow = await findRowByIdx(page, 3);
  await lockedRow.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-edit-boundary]")) === null, "a locked area's popup should not offer Edit boundary");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Row #0 is unlocked and task-linked by design.
  const row0 = await findRowByIdx(page, 0);
  await row0.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-edit-boundary]")) !== null, "an unlocked, linked area's popup should offer Edit boundary");

  const areaBefore = await page.evaluate(() => {
    const entries = window.__blockTriageGetEntries();
    let found = null;
    entries.forEach((e) => {
      if (String(e.idx) === "0") found = e;
    });
    return found ? found.area : null;
  });
  assert(areaBefore !== null, "expected row #0's entry to be found before editing");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  const row0Again = await findRowByIdx(page, 0);
  await row0Again.click();
  await page.waitForTimeout(300);

  await page.click("[data-edit-boundary]");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#draw-status-text", (el) => el.textContent)).includes("Drag a point"),
    "draw-status should explain the edit-boundary interaction"
  );

  // Cancel first, to confirm canceling makes no change at all.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (0)",
    "canceling an edit should queue nothing"
  );
  assert(await page.$eval("#undo-btn", (el) => el.disabled), "canceling an edit should not push an undo action");

  // Now actually edit: re-enter (cancel's renderList() rebuilt the list DOM,
  // so re-query the row rather than reuse a stale handle), drag one vertex
  // marker somewhere else on the map.
  const row0ForEdit = await findRowByIdx(page, 0);
  await row0ForEdit.click();
  await page.waitForTimeout(300);
  await page.click("[data-edit-boundary]");
  await page.waitForTimeout(300);

  const marker = await page.$(".edit-vertex-icon");
  assert(!!marker, "expected at least one draggable vertex marker while editing");
  const markerBox = await marker.boundingBox();
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + mapBox.width / 2 + 80, mapBox.y + mapBox.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (1)",
    "finishing an edit on a linked area should queue it for MapRoulette sync"
  );

  const afterResult = await page.evaluate(() => {
    const entries = window.__blockTriageGetEntries();
    let found = null;
    entries.forEach((e) => {
      if (String(e.idx) === "0") found = e;
    });
    return found ? { area: found.area, mrTaskId: found.mrTaskId } : { area: null, mrTaskId: null };
  });
  assert(afterResult.area !== null, "expected row #0's entry to still exist after editing");
  assert(afterResult.area !== areaBefore, `expected the area to change after dragging a vertex, still ${afterResult.area}`);
  assertEqual(afterResult.mrTaskId, 600001, "the edited entry should keep its original task id until the edit queue is processed");

  // Process the boundary-edit queue: old task deleted, new one created.
  await page.click("#mr-edit-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(
    JSON.stringify(mrState.deletedTaskIds),
    JSON.stringify(["600001"]),
    `expected the old task deleted, got: ${JSON.stringify(mrState.deletedTaskIds)}`
  );
  assertEqual(mrState.createdTasks.length, 1, "expected exactly 1 new task created");
  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (0)",
    "the edit queue should be empty after processing"
  );

  const finalTaskId = await page.evaluate(() => {
    const entries = window.__blockTriageGetEntries();
    let found = null;
    entries.forEach((e) => {
      if (String(e.idx) === "0") found = e;
    });
    return found ? found.mrTaskId : null;
  });
  assert(finalTaskId !== null && finalTaskId !== 600001, `expected a fresh task id after processing, got ${finalTaskId}`);

  assertNoPageErrors(page);
}
