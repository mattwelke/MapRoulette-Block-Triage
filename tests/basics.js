const { launch, assertNoPageErrors, localUrl, sampleDataPath, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("basics: load, select+remove via keyboard, export", async () => {
  const { browser, page } = await launch();

  await page.goto(localUrl());
  await page.waitForTimeout(500);

  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);

  const stats = await page.$eval("#stats", (el) => el.textContent);
  assert(stats.includes("Total: 2387"), `expected 2387 total features, got: ${stats}`);

  const firstRow = await page.$(".feature-row");
  assert(!!firstRow, "expected at least one feature row");
  await firstRow.click();
  await page.waitForTimeout(500);

  await page.keyboard.press("x");
  await page.waitForTimeout(300);
  const statsAfterRemove = await page.$eval("#stats", (el) => el.textContent);
  assert(statsAfterRemove.includes("Total: 2386"), `expected 1 feature removed after pressing x, got: ${statsAfterRemove}`);

  const downloadPath = tmpPath("basics-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);

  const fs = require("fs");
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, 2386, "removed feature should be gone from the export too - it was dropped from memory, not just marked");

  assertNoPageErrors(page);
  await browser.close();
});
