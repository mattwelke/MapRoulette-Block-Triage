const { launch, assertNoPageErrors, appUrl, fixturePath, assert, assertEqual, runTest } = require("./support");

runTest("mr-queue-process: bulk confirm, paced sequential deletes, partial failure handling", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  // Fail the 2nd request deliberately, succeed on the others.
  let requestOrder = [];
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    const m = route.request().url().match(/\/task\/(\d+)/);
    requestOrder.push(m ? m[1] : null);
    if (requestOrder.length === 2) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "Error" }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "OK" }) });
    }
  });

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

  // Queue the 3 largest-area, unlocked features via their popups (locked ones
  // don't get an mr-action button at all - skip over any of those).
  let offset = 0;
  let queuedCount = 0;
  while (queuedCount < 3) {
    const rows = await page.$$(".feature-row");
    const row = rows[rows.length - 1 - offset];
    offset++;
    const isLocked = await row.$eval(".status-dot", (el) => el.classList.contains("locked"));
    if (isLocked) continue;
    await row.click();
    await page.waitForTimeout(200);
    await page.click("[data-mr-action]");
    await page.waitForTimeout(200);
    await page.click(".leaflet-popup-close-button").catch(() => {});
    await page.waitForTimeout(150);
    queuedCount++;
  }

  assertEqual(await page.$eval("#mr-queue-btn", (el) => el.textContent), "Process delete queue (3)", "expected 3 items queued");

  const startTime = Date.now();
  await page.click("#mr-queue-btn");
  await page.waitForTimeout(300);
  assertEqual(dialogs.length, 1, "processing should ask for exactly one bulk confirm");
  assert(dialogs[0].includes("3 tasks"), `expected the confirm to mention 3 tasks, got: ${dialogs[0]}`);

  await page.waitForTimeout(4000); // 3 items paced ~400ms apart, generous margin
  const elapsed = Date.now() - startTime;
  assert(elapsed > 700, `expected pacing between deletes to take noticeably longer than an instant batch, elapsed=${elapsed}ms`);

  const queueStatus = await page.$eval("#mr-queue-status", (el) => el.textContent);
  assert(queueStatus.includes("deleted 2 of 3") && queueStatus.includes("1 failed"), `expected a partial-failure summary, got: ${queueStatus}`);
  assertEqual(
    await page.$eval("#mr-queue-btn", (el) => ({ text: el.textContent, disabled: el.disabled })).then((r) => r.text),
    "Process delete queue (0)",
    "queue should be empty after processing (the failed item is unqueued, just still linked)"
  );

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 8"), "Total should drop by 2 (the 2 that succeeded)");
  assertEqual(requestOrder.length, 3, `expected exactly 3 delete attempts, got: ${JSON.stringify(requestOrder)}`);

  assertNoPageErrors(page);
  await browser.close();
});
