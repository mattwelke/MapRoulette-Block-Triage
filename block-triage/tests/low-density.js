const fs = require("fs");
const { launch, assertNoPageErrors, localUrl, fixturePath, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("low-density: exempts a small area from the area-flag, round-trips through export/import, and undoes", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(localUrl());
  await page.waitForTimeout(400);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1000);

  // The fixture square is roughly 800m x 1000m - set the area threshold well
  // above that so it's flagged as too small, the condition low-density is
  // meant to exempt.
  await page.fill("#area-threshold", "2000000");
  await page.$eval("#area-threshold", (el) => el.dispatchEvent(new Event("input")));
  await page.waitForTimeout(200);

  assertEqual(
    await page.$eval(".status-dot", (el) => el.className),
    "status-dot flagged",
    "the area should be flagged for being smaller than the (deliberately huge) threshold"
  );

  await page.click(".feature-row");
  await page.waitForTimeout(300);
  await page.click("[data-low-density]");
  await page.waitForTimeout(300);

  assertEqual(
    await page.$eval(".status-dot", (el) => el.className),
    "status-dot unreviewed",
    "marking low-density should exempt the area from the small-area flag"
  );

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval(".status-dot", (el) => el.className),
    "status-dot flagged",
    "undo should restore the flag"
  );

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval(".status-dot", (el) => el.className),
    "status-dot unreviewed",
    "redo should reapply the exemption"
  );

  // Export and confirm the property round-trips.
  const downloadPath = tmpPath("low-density-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(
    exported.features[0].properties._blockTriageLowDensity,
    true,
    "the exported feature should carry the low-density property"
  );

  // Re-importing that exact file (a fresh page, so no localStorage marks to
  // fall back on) should recognize the embedded property on its own.
  const { browser: browser2, page: page2 } = await launch();
  page2.on("dialog", async (dialog) => await dialog.accept());
  await page2.goto(localUrl());
  await page2.waitForTimeout(400);
  await page2.fill("#area-threshold", "2000000");
  await page2.$eval("#area-threshold", (el) => el.dispatchEvent(new Event("input")));
  await page2.setInputFiles("#file-input", downloadPath);
  await page2.waitForTimeout(1000);
  assertEqual(
    await page2.$eval(".status-dot", (el) => el.className),
    "status-dot unreviewed",
    "re-importing the exported file should recognize the low-density mark from its own properties"
  );
  assertNoPageErrors(page2);
  await browser2.close();

  assertNoPageErrors(page);
  await browser.close();
});
