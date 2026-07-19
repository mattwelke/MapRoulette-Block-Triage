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

runTest("mr-split-queue-blocks: a pending split blocks other actions and can be canceled", async () => {
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

  // Row #9 is the largest, unlocked, task-linked feature by design.
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

  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (1)",
    "the split should be queued"
  );

  const rowAfterQueue = await findRowByIdx(page, 9);
  assert(
    await rowAfterQueue.evaluate((el) => el.classList.contains("mr-split-queued")),
    "the split-queued row should have the mr-split-queued class"
  );

  // Opening its popup again should offer only "Cancel pending split" - no
  // Split, Edit boundary, or remove/add action while a split is pending.
  await rowAfterQueue.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-split]")) === null, "a split-pending area's popup should not offer Split again");
  assert((await page.$("[data-edit-boundary]")) === null, "a split-pending area's popup should not offer Edit boundary");
  assert((await page.$("[data-mr-action]")) === null, "a split-pending area's popup should not offer the add/remove action");
  assert((await page.$("[data-cancel-split]")) !== null, "a split-pending area's popup should offer Cancel pending split");

  // Quick queue-delete mode should also refuse to touch it - clicking it on
  // the map (not the sidebar, which always opens the popup regardless of
  // this mode) should alert instead of queueing it for deletion.
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);
  await page.click("#mr-quick-queue-checkbox");
  await page.waitForTimeout(150);
  const mapCenter = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const preQueueDialogCount = dialogs.length;
  await page.mouse.click(mapCenter.x, mapCenter.y);
  await page.waitForTimeout(300);
  assert(dialogs.length > preQueueDialogCount, "quick-queue map click on a split-pending area should alert, not queue");
  assert(
    dialogs[dialogs.length - 1].includes("queued for a pending split"),
    `expected an alert explaining the pending split blocks quick queue-delete, got: ${dialogs[dialogs.length - 1]}`
  );
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => el.textContent),
    "Process delete queue (0)",
    "quick queue-delete should not have queued the split-pending area"
  );
  await page.click("#mr-quick-queue-checkbox"); // toggle back off
  await page.waitForTimeout(150);

  // Cancel the pending split via the popup button.
  const rowToCancel = await findRowByIdx(page, 9);
  await rowToCancel.click();
  await page.waitForTimeout(300);
  await page.click("[data-cancel-split]");
  await page.waitForTimeout(200);

  assertEqual(
    await page.$eval("#mr-split-queue-btn", (el) => el.textContent),
    "Process split queue (0)",
    "canceling should empty the split queue"
  );
  const rowAfterCancel = await findRowByIdx(page, 9);
  assert(
    !(await rowAfterCancel.evaluate((el) => el.classList.contains("mr-split-queued"))),
    "the row should no longer show the pending-split style after canceling"
  );
  await rowAfterCancel.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-split]")) !== null, "Split should be offered again after canceling the pending split");

  assertNoPageErrors(page);
  await browser.close();
});
