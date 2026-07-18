const { launch, assertNoPageErrors, indexUrl, sampleDataPath, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("basics: load, select+exclude via keyboard, export", async () => {
  const { browser, page } = await launch();

  await page.goto(indexUrl());
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
  const statsAfterExclude = await page.$eval("#stats", (el) => el.textContent);
  assert(statsAfterExclude.includes("Excluded: 1"), `expected 1 excluded after pressing x, got: ${statsAfterExclude}`);

  const downloadPath = tmpPath("basics-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);

  const fs = require("fs");
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, 2386, "excluded feature should be dropped from the export");

  assertNoPageErrors(page);
  await browser.close();
});
