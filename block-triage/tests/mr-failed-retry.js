const { launch, assertNoPageErrors, appUrl, fixturePath, assert, assertEqual, runTest } = require("./support");

runTest("mr-failed-retry: a failed delete drops the queued styling and stays retryable", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  let count = 0;
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    count++;
    if (count === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
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

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(200);
  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});

  await page.click("#mr-queue-btn"); // process (will fail, since count===1)
  await page.waitForTimeout(2000);

  const freshRows = await page.$$(".feature-row");
  const rowClass = await freshRows[freshRows.length - 1].getAttribute("class");
  assert(!rowClass.includes("mr-delete-queued"), `failed item should drop the queued styling, got class: ${rowClass}`);

  await freshRows[freshRows.length - 1].click();
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "the failed item should still be linked and ready to retry"
  );

  assertNoPageErrors(page);
  await browser.close();
});
