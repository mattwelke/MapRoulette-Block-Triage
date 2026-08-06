const {
  launch,
  assert,
  assertEqual,
  assertNoPageErrors,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
  liveUrl,
} = require("./support");

const CHALLENGE_ID = 90100;

// A single square big enough for a clean vertical cut, matching the style of
// square.geojson - well above the default 5000m² target-area threshold so
// it isn't ALSO flagged oversized, keeping the could-not-complete color the
// only thing distinguishing it in these tests.
const SQUARE_GEOMETRY = {
  type: "Polygon",
  coordinates: [
    [
      [-79.8, 43.45],
      [-79.79, 43.45],
      [-79.79, 43.46],
      [-79.8, 43.46],
      [-79.8, 43.45],
    ],
  ],
};

async function drawVerticalSplitLine(page) {
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + 10);
  await page.waitForTimeout(150);
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height - 10);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
}

// The feature list is virtualized (see renderVisibleRows() in live.js) - the
// DOM nodes behind any previously-queried ElementHandle can be torn down and
// rebuilt by the next renderList() (e.g. right after a click opens a popup
// and pans the map), so collect (id, statusDotClass) pairs up front via
// $$eval and re-select `.feature-row[data-id="..."]` fresh for every click
// instead of reusing element handles across state-changing actions.
async function listRows(page) {
  return page.$$eval(".feature-row", (rows) =>
    rows.map((r) => ({ id: r.dataset.id, statusDotClass: r.querySelector(".status-dot").className }))
  );
}

async function clickRow(page, id) {
  await page.click(`.feature-row[data-id="${id}"]`);
  await page.waitForTimeout(300);
}

runTest("could-not-complete: a Too_Hard task is highlighted with its own category, not oversized/undersized/normal", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await listRows(page);
  assertEqual(rows.length, 1, "expected exactly one loaded task");
  assert(
    rows[0].statusDotClass.includes("could-not-complete"),
    `expected the status dot to be could-not-complete, got: ${rows[0].statusDotClass}`
  );
  assert(
    !rows[0].statusDotClass.includes("oversized"),
    `could-not-complete should take priority over oversized, got: ${rows[0].statusDotClass}`
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("could-not-complete: splitting a Too_Hard area offers a per-piece checkbox; splitting a normal one doesn't", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [
    makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard"),
    makeMrTask(
      502,
      {
        type: "Polygon",
        coordinates: [
          [
            [-79.6, 43.45],
            [-79.59, 43.45],
            [-79.59, 43.46],
            [-79.6, 43.46],
            [-79.6, 43.45],
          ],
        ],
      },
      "Created"
    ),
  ]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Split the Created (normal) task first.
  const initialRows = await listRows(page);
  const normalRow = initialRows.find((r) => !r.statusDotClass.includes("could-not-complete"));
  assert(!!normalRow, "expected to find the non-could-not-complete row");
  await clickRow(page, normalRow.id);
  await page.click("[data-split]");
  await page.waitForTimeout(200);
  await drawVerticalSplitLine(page);

  // Both freshly-split pieces should be selectable and show no checkbox.
  let checkedAnyNormalPiece = false;
  for (const row of await listRows(page)) {
    await clickRow(page, row.id);
    if (await page.$("[data-drop-split-piece]")) {
      if (await page.$("[data-keep-could-not-complete]")) checkedAnyNormalPiece = true;
    }
  }
  assert(!checkedAnyNormalPiece, "splitting a normal (non could-not-complete) area should not offer the keep-checkbox");

  await page.click("#undo-btn"); // back out the normal split, leaving just the two original tasks
  await page.waitForTimeout(300);

  // Now split the actual Too_Hard task.
  const rowsBeforeCncSplit = await listRows(page);
  const cncRow = rowsBeforeCncSplit.find((r) => r.statusDotClass.includes("could-not-complete"));
  assert(!!cncRow, "expected to find the could-not-complete row");
  await clickRow(page, cncRow.id);
  await page.click("[data-split]");
  await page.waitForTimeout(200);
  await drawVerticalSplitLine(page);

  // 502 (untouched) plus the two fresh pieces of 501 - identify the pieces
  // by their "Drop this piece" button rather than assuming a row count,
  // since 502's own row is still present alongside them.
  let pieceRowCount = 0;
  for (const row of await listRows(page)) {
    await clickRow(page, row.id);
    const isPendingSplitPiece = !!(await page.$("[data-drop-split-piece]"));
    if (!isPendingSplitPiece) continue;
    pieceRowCount++;
    const checkbox = await page.$("[data-keep-could-not-complete]");
    assert(!!checkbox, "each piece of a could-not-complete split should offer the keep-checkbox");
  }
  assertEqual(pieceRowCount, 2, `expected exactly 2 pending-split pieces after splitting the could-not-complete task, got ${pieceRowCount}`);

  assertNoPageErrors(page);
  await browser.close();
});

runTest("could-not-complete: processing the split queue sets only the checked piece(s) to Too_Hard", async () => {
  const { browser, page } = await launch();
  const mrState = await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await listRows(page);
  await clickRow(page, rows[0].id);
  await page.click("[data-split]");
  await page.waitForTimeout(200);
  await drawVerticalSplitLine(page);

  const pieceRows = await listRows(page);
  assertEqual(pieceRows.length, 2, "expected 2 pieces after the split");

  await clickRow(page, pieceRows[0].id);
  await page.click("[data-keep-could-not-complete]");
  await page.waitForTimeout(150);

  await page.click("#mr-split-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(JSON.stringify(mrState.deletedTaskIds), JSON.stringify(["501"]), `expected only the original task deleted, got: ${JSON.stringify(mrState.deletedTaskIds)}`);
  assertEqual(mrState.createdTasks.length, 2, "both pieces should get a new task created");
  assertEqual(mrState.statusSetCalls.length, 1, `expected exactly one status-set call, got: ${JSON.stringify(mrState.statusSetCalls)}`);
  assertEqual(mrState.statusSetCalls[0].status, "6", "the follow-up status call should set Too_Hard (6)");

  assertNoPageErrors(page);
  await browser.close();
});
