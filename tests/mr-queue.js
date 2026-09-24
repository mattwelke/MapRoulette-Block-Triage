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

runTest("mr-queue: Remove queues instead of deleting immediately, Cancel dequeues", async () => {
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

  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "queue button should start at 0"
  );
  assert(await page.$eval("#mr-queue-btn", (el) => el.disabled), "queue button should be disabled with nothing queued");

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);

  await page.click("[data-mr-action]");
  await page.waitForTimeout(300);
  assertEqual(dialogs.length, 0, "queueing needs no confirm");
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending removal",
    "button should flip after queueing"
  );
  assert(
    (await page.$eval("[data-mr-status]", (el) => el.textContent)).toLowerCase().includes("queued"),
    "inline status should mention queueing"
  );
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (1)",
    "queue button should now show 1"
  );
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"), "nothing should be deleted yet");

  const freshRows = await page.$$(".feature-row"); // renderList() rebuilds the DOM on queue change
  const rowClass = await freshRows[freshRows.length - 1].getAttribute("class");
  assert(rowClass.includes("mr-delete-queued"), `expected the queued row to carry mr-delete-queued, got: ${rowClass}`);

  await page.click("[data-mr-action]"); // cancel
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "canceling should flip the button back"
  );
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "queue button should drop back to 0"
  );

  assertNoPageErrors(page);
  await browser.close();
});
