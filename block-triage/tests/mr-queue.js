const { launch, assertNoPageErrors, indexUrl, fixturePath, assert, assertEqual, runTest } = require("./support");

runTest("mr-queue: Remove queues instead of deleting immediately, Cancel dequeues", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.goto(indexUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

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
