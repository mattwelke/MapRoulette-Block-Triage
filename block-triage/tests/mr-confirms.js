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

runTest("mr-confirms: queueing (including a split) needs no confirm, only processing a queue does", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss(); // specifically testing the decline path
  });

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "sanity: this row should be a loaded, unlocked task"
  );

  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 0, "queueing is fully reversible - no confirm should be shown");
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending removal",
    "button should reflect the queued state"
  );

  await page.click("[data-mr-action]"); // dequeue
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 0, "dequeueing is also fully reversible - still no confirm");

  await page.click("[data-mr-action]"); // re-queue
  await page.waitForTimeout(200);
  await page.click("#mr-queue-btn"); // process - should ask for one bulk confirm
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 1, "processing the queue should ask for exactly one confirm");
  assert(dialogs[0].includes("permanently delete"), `expected a deletion confirm, got: ${dialogs[0]}`);
  const queueLabelAfterDecline = await page.$eval("#mr-queue-btn", (el) => el.textContent);
  assert(queueLabelAfterDecline.includes("(1)"), `declining the confirm should leave the item queued, got: ${queueLabelAfterDecline}`);

  await page.click("[data-split]");
  await page.waitForTimeout(600); // split does a live lock recheck before entering draw mode - give the mocked request time
  assertEqual(dialogs.length, 1, "clicking Split should enter draw mode directly - no confirm until the split queue is processed");
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "clicking Split should enter draw mode");

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

  assertEqual(dialogs.length, 1, "finishing the cut should just queue the split - still no new confirm");
  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split should be queued for processing"
  );

  await page.click("#mr-split-queue-btn");
  await page.waitForTimeout(200);
  assertEqual(dialogs.length, 2, "processing the split queue should ask for exactly one confirm");
  assert(dialogs[1].includes("split"), `expected a split-processing confirm, got: ${dialogs[1]}`);
  const splitLabelAfterDecline = await page.$eval("#mr-split-queue-btn", (el) => el.textContent);
  assert(
    splitLabelAfterDecline.includes("(1)"),
    `declining the confirm should leave the split queued, got: ${splitLabelAfterDecline}`
  );

  assertNoPageErrors(page);
  await browser.close();
});
