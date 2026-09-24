const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 91001;

async function drawTriangle(page, offsetX, offsetY) {
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const base = { x: mapBox.x + mapBox.width / 2 + offsetX, y: mapBox.y + mapBox.height / 2 + offsetY };
  const pts = [
    { x: base.x, y: base.y },
    { x: base.x + 60, y: base.y },
    { x: base.x + 30, y: base.y + 60 },
  ];
  await page.click("#add-area-btn");
  await page.waitForTimeout(150);
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
}

async function findRowByIdPrefix(page, prefix) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label.includes(prefix)) return row;
  }
  return null;
}

runTest("mr-add-queue: new areas auto-queue for adding, toggle, Add now, and bulk processing", async () => {
  const { browser, page } = await launch();
  try {
    await runBody(page);
  } finally {
    await browser.close();
  }
});

async function runBody(page) {
  page.on("dialog", async (dialog) => await dialog.accept());

  let createdCount = 0;
  const createdBodies = [];
  await routeMrChallenge(page, CHALLENGE_ID, []);
  await page.route("https://maproulette.org/api/v2/task", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createdCount++;
    let body = {};
    try {
      body = JSON.parse(route.request().postData());
    } catch (err) {
      // ignore
    }
    createdBodies.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 8000 + createdCount }) });
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (0)",
    "add-queue button should start at 0"
  );
  assert(await page.$eval("#mr-add-queue-btn", (el) => el.disabled), "add-queue button should be disabled with nothing queued");

  // Draw a new area - should auto-queue.
  await drawTriangle(page, -250, -150);
  const row1 = await findRowByIdPrefix(page, "new-1");
  assert(!!row1, "expected the freshly-drawn area in the list");
  assert((await row1.getAttribute("class")).includes("mr-add-queued"), "a freshly-drawn area's row should show as add-queued");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (1)",
    "add-queue button should reflect the auto-queued area"
  );

  await row1.click();
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending add",
    "popup should offer to cancel the pending add"
  );
  assert((await page.$("[data-mr-add-now]")) !== null, "popup should also offer Add now");

  // Toggle it off, then back on.
  await page.click("[data-mr-action]");
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Queue for adding",
    "canceling the pending add should flip the button back"
  );
  assertEqual(await page.$eval("#mr-add-queue-btn", (el) => el.textContent), "Process add queue (0)", "queue should drop to 0");
  await page.click("[data-mr-action]");
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending add",
    "re-queueing should flip the button back again"
  );
  assertEqual(await page.$eval("#mr-add-queue-btn", (el) => el.textContent), "Process add queue (1)", "queue should be back to 1");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Draw a second new area - also auto-queued, bringing the count to 2.
  await drawTriangle(page, 0, -150);
  const row2 = await findRowByIdPrefix(page, "new-2");
  assert(!!row2, "expected the second freshly-drawn area in the list");
  assertEqual(await page.$eval("#mr-add-queue-btn", (el) => el.textContent), "Process add queue (2)", "queue should show 2");

  // Process the add queue - both should get created, no confirm dialog needed.
  const dialogsBefore = [];
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    dialogsBefore.push(dialog.message());
    await dialog.accept();
  });
  await page.click("#mr-add-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(dialogsBefore.length, 0, "processing the add queue should not need a confirm - creating tasks isn't destructive");
  assertEqual(createdCount, 2, `expected 2 tasks created, got ${createdCount}`);
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (0)",
    "add queue should be empty after processing"
  );
  assert(
    (await page.$eval("#mr-add-queue-status", (el) => el.textContent)).includes("added 2"),
    "add-queue status should confirm both were added"
  );

  const row1After = await findRowByIdPrefix(page, "new-1");
  assert(!(await row1After.getAttribute("class")).includes("mr-add-queued"), "processed area should no longer show as add-queued");
  await row1After.click();
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "a processed area should now be linked and offer Remove"
  );
  assert((await page.$("[data-mr-add-now]")) === null, "a now-linked area's popup should no longer offer Add now");

  assertNoPageErrors(page);
}
