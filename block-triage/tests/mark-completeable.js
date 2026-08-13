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

const CHALLENGE_ID = 90110;

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

async function listRows(page) {
  return page.$$eval(".feature-row", (rows) =>
    rows.map((r) => ({ id: r.dataset.id, statusDotClass: r.querySelector(".status-dot").className }))
  );
}

async function clickRow(page, id) {
  await page.click(`.feature-row[data-id="${id}"]`);
  await page.waitForTimeout(300);
}

runTest("mark-completeable: a Could Not Complete area's popup offers Mark as Completeable instead of Mark as Could Not Complete", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await listRows(page);
  await clickRow(page, rows[0].id);

  assert(!(await page.$("[data-mark-could-not-complete]")), "an already Could Not Complete area shouldn't offer Mark as Could Not Complete again");
  assert(!!(await page.$("[data-mark-completeable]")), "a Could Not Complete area should offer Mark as Completeable");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mark-completeable: Mark as Completeable queues the change instead of applying it right away", async () => {
  const { browser, page } = await launch();
  const mrState = await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await listRows(page);
  assert(rows[0].statusDotClass.includes("could-not-complete"), "sanity: should start as could-not-complete");
  await clickRow(page, rows[0].id);

  const markBtn = await page.$("[data-mark-completeable]");
  await markBtn.click();
  await page.waitForTimeout(200);

  assertEqual(mrState.statusSetCalls.length, 0, "queueing the mark should not call the API yet");
  assertEqual(
    await page.$eval("#mr-mark-completeable-queue-btn", (el) => el.textContent),
    "Process completeable queue (1)",
    "the queue button should reflect the pending mark"
  );
  const rowsStillQueued = await listRows(page);
  assert(rowsStillQueued[0].statusDotClass.includes("could-not-complete"), "the area shouldn't recolor to normal until the queue is actually processed");

  // Re-open and toggle it back off - fully reversible while still pending.
  await clickRow(page, rows[0].id);
  assertEqual(
    await page.$eval("[data-mark-completeable]", (el) => el.textContent),
    "Cancel pending mark",
    "the button should reflect the pending state"
  );
  await page.click("[data-mark-completeable]");
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("#mr-mark-completeable-queue-btn", (el) => el.textContent),
    "Process completeable queue (0)",
    "cancelling should empty the queue again"
  );

  // Queue it again and actually process it this time.
  await clickRow(page, rows[0].id);
  await page.click("[data-mark-completeable]");
  await page.waitForTimeout(200);
  await page.click("#mr-mark-completeable-queue-btn");
  await page.waitForTimeout(500);

  // MapRoulette's own server rejects a direct Too_Hard -> Created status
  // PUT (see the comment on processMrMarkCompleteableQueue) - this deletes
  // the old task and creates a fresh one for the same geometry instead.
  assertEqual(mrState.statusSetCalls.length, 0, "should never be a status-set call - Too_Hard can't go straight back to Created");
  assertEqual(
    JSON.stringify(mrState.deletedTaskIds),
    JSON.stringify(["501"]),
    `expected the old Too_Hard task to be deleted, got: ${JSON.stringify(mrState.deletedTaskIds)}`
  );
  assertEqual(mrState.createdTasks.length, 1, `expected exactly one new task created, got: ${JSON.stringify(mrState.createdTasks)}`);
  const rowsAfter = await listRows(page);
  assert(!rowsAfter[0].statusDotClass.includes("could-not-complete"), "the area should no longer be could-not-complete once the queue is processed");
  assertEqual(
    await page.$eval("#mr-mark-completeable-queue-btn", (el) => el.textContent),
    "Process completeable queue (0)",
    "the queue should be empty after processing"
  );

  // Re-open the popup - it should now offer Mark as Could Not Complete
  // again instead, since it's back to a normal workable state.
  await clickRow(page, rows[0].id);
  assert(!(await page.$("[data-mark-completeable]")), "the button should no longer appear once the area is completeable again");
  assert(!!(await page.$("[data-mark-could-not-complete]")), "Mark as Could Not Complete should be offered again now that it's a normal task");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mark-completeable: appears in Process all pending's total and gets processed by it", async () => {
  const { browser, page } = await launch();
  const mrState = await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await listRows(page);
  await clickRow(page, rows[0].id);
  await page.click("[data-mark-completeable]");
  await page.waitForTimeout(200);

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (1)",
    "the pending completeable mark should count toward Process all pending's total"
  );

  await page.click("#mr-process-all-btn");
  await page.waitForTimeout(500);

  assertEqual(
    JSON.stringify(mrState.deletedTaskIds),
    JSON.stringify(["501"]),
    `expected Process all pending to have processed the completeable queue too, got deleted: ${JSON.stringify(mrState.deletedTaskIds)}`
  );
  assertEqual(mrState.createdTasks.length, 1, `expected a replacement task to be created, got: ${JSON.stringify(mrState.createdTasks)}`);

  assertNoPageErrors(page);
  await browser.close();
});

runTest("mark-completeable: a delete failure leaves the task queued for retry, without creating a duplicate", async () => {
  const { browser, page } = await launch();
  const mrState = await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(501, SQUARE_GEOMETRY, "Too_Hard")]);
  mrState.deleteAlwaysFailsStatus = 500;

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await listRows(page);
  await clickRow(page, rows[0].id);
  await page.click("[data-mark-completeable]");
  await page.waitForTimeout(200);
  await page.click("#mr-mark-completeable-queue-btn");
  await page.waitForTimeout(3000); // mrRequest's own retries need to exhaust first

  assertEqual(mrState.createdTasks.length, 0, "a failed delete should never be followed by a create - that would duplicate the task");
  assertEqual(
    await page.$eval("#mr-mark-completeable-queue-btn", (el) => el.textContent),
    "Process completeable queue (1)",
    "the failed mark should stay queued to retry next time"
  );
  const rowsAfter = await listRows(page);
  assert(rowsAfter[0].statusDotClass.includes("could-not-complete"), "the area should still read as could-not-complete - nothing actually changed on MapRoulette");

  assertNoPageErrors(page);
  await browser.close();
});
