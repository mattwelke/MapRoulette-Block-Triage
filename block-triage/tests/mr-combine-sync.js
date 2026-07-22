const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90101;

function square(lng, lat, size) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng, lat],
        [lng + size, lat],
        [lng + size, lat + size],
        [lng, lat + size],
        [lng, lat],
      ],
    ],
  };
}

async function findRowByIdMatcher(page, matcher) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (matcher(label)) return row;
  }
  return null;
}

runTest("mr-combine-sync: combining two task-linked areas queues the sync instead of touching mrAddQueue", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  // Two squares sharing a boundary, each with its own task.
  const tasks = [makeMrTask(800001, square(-79.7, 43.45, 0.001), "Created"), makeMrTask(800002, square(-79.699, 43.45, 0.001), "Created")];
  const mrState = await routeMrChallenge(page, CHALLENGE_ID, tasks);

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "expected both linked tasks to load");

  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  const rows = await page.$$(".feature-row");
  assert(rows.length === 2, "expected exactly 2 rows to select for combining");
  await rows[0].click();
  await page.waitForTimeout(150);
  const rowsAgain = await page.$$(".feature-row"); // renderList() rebuilt the DOM
  await rowsAgain[1].click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "combining should merge to 1 area");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (0)",
    "combining task-linked areas should NOT auto-queue the merged area into the plain add queue"
  );
  assertEqual(
    await page.$eval("#mr-combine-queue-btn", (el) => el.textContent),
    "Process combine queue (1)",
    "finishing the combine should queue exactly one combine group"
  );

  const combinedRow = await findRowByIdMatcher(page, (l) => l.includes("+"));
  assert(!!combinedRow, "expected the merged area's row, tagged with a joined id");
  assert(
    await combinedRow.evaluate((el) => el.classList.contains("mr-combine-queued")),
    "the queued merge's row should show as combine-queued"
  );

  // A pending-combine area should be off-limits to other structural actions.
  await combinedRow.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-split]")) === null, "a combine-pending area's popup should not offer Split");
  assert((await page.$("[data-mr-action]")) === null, "a combine-pending area's popup should not offer the add/remove action");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Process the combine queue: both originals' tasks should get deleted,
  // and exactly one new task created for the merged area.
  await page.click("#mr-combine-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(dialogs.length, 1, `expected exactly one confirm for processing the combine queue, got: ${JSON.stringify(dialogs)}`);
  assertEqual(mrState.deletedTaskIds.length, 2, "expected exactly 2 delete requests, one per constituent");
  assertEqual(mrState.createdTasks.length, 1, "expected exactly 1 create request for the merged area");
  assertEqual(
    await page.$eval("#mr-combine-queue-btn", (el) => el.textContent),
    "Process combine queue (0)",
    "the combine queue should be empty after processing"
  );

  const combinedRowAfter = await findRowByIdMatcher(page, (l) => l.includes("+"));
  assert(
    !(await combinedRowAfter.evaluate((el) => el.classList.contains("mr-combine-queued"))),
    "the merged area should no longer show as combine-queued once processed"
  );
  await combinedRowAfter.click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "the processed merge should now be linked to its newly-created task"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mr-combine-sync: combining unlinked areas still auto-queues into mrAddQueue, and undo/redo restore combine-queue state", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await routeMrChallenge(page, CHALLENGE_ID, []);
  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 0"), "expected no tasks to load");

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  // Draw two adjacent triangles sharing an edge, neither linked to a task.
  async function drawTriangle(points) {
    await page.click("#add-area-btn");
    await page.waitForTimeout(150);
    for (const p of points) {
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(120);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  const cx = mapBox.x + mapBox.width / 2;
  const cy = mapBox.y + mapBox.height / 2;
  await drawTriangle([
    { x: cx - 100, y: cy - 100 },
    { x: cx, y: cy - 100 },
    { x: cx - 50, y: cy },
  ]);
  await drawTriangle([
    { x: cx, y: cy - 100 },
    { x: cx + 100, y: cy - 100 },
    { x: cx - 50, y: cy },
  ]);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "expected 2 drawn, unlinked areas");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (2)",
    "both freshly-drawn areas should already be queued for adding"
  );

  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  const rows = await page.$$(".feature-row");
  await rows[0].click();
  await page.waitForTimeout(150);
  const rowsAgain = await page.$$(".feature-row");
  await rowsAgain[1].click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "combining should merge to 1 area");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (1)",
    "combining unlinked areas should still auto-queue the merged area for adding"
  );
  assertEqual(
    await page.$eval("#mr-combine-queue-btn", (el) => el.textContent),
    "Process combine queue (1)",
    "the combine group should still be tracked even though there's nothing to delete remotely"
  );

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "undo should split the merge back apart");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (2)",
    "undo should drop the merged area from the add queue and restore both originals to it"
  );
  assertEqual(
    await page.$eval("#mr-combine-queue-btn", (el) => el.textContent),
    "Process combine queue (0)",
    "undo should also drop the group from the combine queue"
  );

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "redo should reapply the merge");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (1)",
    "redo should re-queue the merged area for adding"
  );
  assertEqual(
    await page.$eval("#mr-combine-queue-btn", (el) => el.textContent),
    "Process combine queue (1)",
    "redo should re-queue the combine group"
  );

  assertNoPageErrors(page);
  await browser.close();
});
