const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  mrChallengeSampleTasks,
  makeMrTask,
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

runTest("mr-low-density: exempts an undersized task from the size check and syncs the mark to MapRoulette", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Row #0 is the smallest feature by design (see mrChallengeSampleTasks) -
  // well under half of the default 5000 m² target, so it starts undersized.
  const row0 = await findRowByIdx(page, 0);
  assert(!!row0, "expected to find row #0");
  assertEqual(
    await row0.$eval(".status-dot", (el) => el.className),
    "status-dot undersized",
    "row #0 should start undersized"
  );

  await row0.click();
  await page.waitForTimeout(300);
  await page.click("[data-low-density]");
  await page.waitForTimeout(300);

  const row0After = await findRowByIdx(page, 0);
  assertEqual(
    await row0After.$eval(".status-dot", (el) => el.className),
    "status-dot normal",
    "marking low-density should exempt row #0 from the undersized verdict"
  );

  // Row #0 is task-linked, so the mark needs to reach MapRoulette eventually -
  // reuses the boundary-edit queue's delete+recreate mechanism for that.
  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (1)",
    "toggling low-density on a linked area should queue a re-sync"
  );

  await page.click("#mr-edit-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(mrState.deletedTaskIds.length, 1, "expected the old task to be deleted");
  assertEqual(mrState.createdTasks.length, 1, "expected a new task created with the updated properties");
  const createdProps = mrState.createdTasks[0].geometries.features[0].properties;
  assertEqual(createdProps._blockTriageLowDensity, true, "the newly-created task should carry the low-density property");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mr-low-density: exempts an oversized task too, and the stats counts match", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

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
  // A single large square, well over the default 5000 m² target - starts
  // oversized on its own.
  const tasks = [makeMrTask(800001, square(-79.7, 43.45, 0.002), "Created")];
  const mrState = await routeMrChallenge(page, CHALLENGE_ID, tasks);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await page.$$(".feature-row");
  assertEqual(rows.length, 1, "expected exactly one loaded task");
  assertEqual(await rows[0].$eval(".status-dot", (el) => el.className), "status-dot oversized", "the task should start oversized");
  const statsBefore = await page.$eval("#stats", (el) => el.textContent);
  assert(statsBefore.includes("Oversized (needs split): 1"), `expected 1 oversized before marking, got: ${statsBefore}`);

  await rows[0].click();
  await page.waitForTimeout(300);
  await page.click("[data-low-density]");
  await page.waitForTimeout(300);

  const rowsAfter = await page.$$(".feature-row");
  assertEqual(
    await rowsAfter[0].$eval(".status-dot", (el) => el.className),
    "status-dot normal",
    "marking low-density should exempt the task from the oversized verdict too - a low-density area can legitimately be large"
  );
  const statsAfter = await page.$eval("#stats", (el) => el.textContent);
  assert(
    statsAfter.includes("Oversized (needs split): 0") && statsAfter.includes("Normal: 1"),
    `the oversized count should drop to 0 (and normal rise to 1) once it's exempted, got: ${statsAfter}`
  );

  await page.click("#mr-edit-queue-btn");
  await page.waitForTimeout(1500);
  const createdProps = mrState.createdTasks[mrState.createdTasks.length - 1].geometries.features[0].properties;
  assertEqual(createdProps._blockTriageLowDensity, true, "the re-synced task should carry the low-density property");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mr-low-density: a task loaded with the property already marked comes back exempted, and undo reverses a toggle", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

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
  // A tiny square, well under half the default 5000 m² target - would be
  // undersized on its own, if not for the property already marking it exempt.
  const tasks = [makeMrTask(700001, square(-79.7, 43.45, 0.0002), "Created")];
  // makeMrTask builds a plain task with empty geometry properties - stamp the
  // low-density mark on directly, since it doesn't take arbitrary properties.
  tasks[0].geometries.features[0].properties = { _blockTriageLowDensity: true };

  await routeMrChallenge(page, CHALLENGE_ID, tasks);
  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await page.$$(".feature-row");
  assertEqual(rows.length, 1, "expected exactly one loaded task");
  assertEqual(
    await rows[0].$eval(".status-dot", (el) => el.className),
    "status-dot normal",
    "a task loaded with the low-density property already set should come back exempted, not undersized"
  );

  // Toggle it off, then undo.
  await rows[0].click();
  await page.waitForTimeout(300);
  await page.click("[data-low-density]");
  await page.waitForTimeout(300);
  const rowsAfterToggle = await page.$$(".feature-row");
  assertEqual(
    await rowsAfterToggle[0].$eval(".status-dot", (el) => el.className),
    "status-dot undersized",
    "unmarking low-density should bring back the undersized verdict"
  );

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const rowsAfterUndo = await page.$$(".feature-row");
  assertEqual(
    await rowsAfterUndo[0].$eval(".status-dot", (el) => el.className),
    "status-dot normal",
    "undo should restore the low-density exemption"
  );

  assertNoPageErrors(page);
  await browser.close();
});
