const fs = require("fs");
const { launch, appUrl, sampleDataPath, tmpPath, assert, runTest } = require("./support");

runTest("persist-kept: _blockTriageStatus round-trips without localStorage", async () => {
  const { browser, page } = await launch();

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);

  await page.click(".feature-row");
  await page.waitForTimeout(200);
  await page.keyboard.press("g"); // keep
  await page.waitForTimeout(200);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Kept: 1"), "expected 1 kept after pressing g");

  const downloadPath = tmpPath("persist-kept-roundtrip.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);

  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  const keptCount = exported.features.filter((f) => f.properties && f.properties._blockTriageStatus === "kept").length;
  assert(keptCount === 1, `expected exactly 1 feature with _blockTriageStatus=kept in the export, got ${keptCount}`);

  // Fresh, isolated browser context - localStorage cannot carry over at all -
  // the kept status must be recognized purely from the exported property.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await page2.setViewportSize({ width: 1400, height: 900 });
  await page2.goto(appUrl());
  await page2.waitForTimeout(500);
  await page2.setInputFiles("#file-input", downloadPath);
  await page2.waitForTimeout(4000);
  const stats2 = await page2.$eval("#stats", (el) => el.textContent);
  assert(stats2.includes("Kept: 1"), `expected the round-tripped file to still show Kept: 1, got: ${stats2}`);

  await browser.close();
});
