const fs = require("fs");
const { launch, assertNoPageErrors, appUrl, fixturePath, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("mr-remove-purges: a successfully-deleted task disappears from map/list/stats/export", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  let deletedTaskId = null;
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    const m = route.request().url().match(/\/task\/(\d+)/);
    deletedTaskId = m ? m[1] : null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "OK" }) });
  });

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"), "expected 10 features loaded");

  const rows = await page.$$(".feature-row");
  const targetLabel = await rows[rows.length - 1].$eval(".id", (el) => el.textContent);
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);

  await page.click("[data-mr-action]"); // queue
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.click("#mr-queue-btn"); // process
  await page.waitForTimeout(1500);

  assert(deletedTaskId === "600010", `expected task 600010 to be deleted, got: ${deletedTaskId}`);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 9"), "Total should drop by 1 after a successful delete");
  assert((await page.$(".leaflet-popup")) === null, "popup should be closed after removal");

  const stillPresent = await page.$$eval(".feature-row .id", (els, label) => els.some((e) => e.textContent === label), targetLabel);
  assert(!stillPresent, "the removed feature's row should no longer be in the sidebar list");

  const downloadPath = tmpPath("mr-remove-purges-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, 9, "the in-memory GeoJSON used for export should also have dropped the removed feature");
  assert(
    !exported.features.some((f) => f.properties && f.properties.mr_taskId === "600010"),
    "the deleted task's mr_taskId should not appear anywhere in the export"
  );

  assertNoPageErrors(page);
  await browser.close();
});
