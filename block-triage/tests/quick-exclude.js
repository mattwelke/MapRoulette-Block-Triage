const { launch, assertNoPageErrors, indexUrl, sampleDataPath, assert, runTest } = require("./support");

runTest("quick-exclude: map-click toggling, popup carve-out", async () => {
  const { browser, page } = await launch();

  await page.goto(indexUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);

  // Default mode: clicking the map polygon opens a popup.
  await page.click(".feature-row"); // selects smallest feature, pans map to it
  await page.waitForTimeout(500);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert((await page.$(".leaflet-popup")) !== null, "default mode: map click should open a popup");

  await page.keyboard.press("r");
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelectorAll(".leaflet-popup-close-button").forEach((b) => b.click()));
  await page.waitForTimeout(200);

  await page.click("#quick-exclude-checkbox");
  await page.waitForTimeout(200);
  assert(
    await page.$eval("#app", (el) => el.classList.contains("quick-exclude-active")),
    "quick-exclude-active class should apply once the checkbox is on"
  );

  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert((await page.$(".leaflet-popup")) === null, "quick mode: map click should NOT open a popup");
  const statsQuick = await page.$eval("#stats", (el) => el.textContent);
  assert(statsQuick.includes("Excluded: 1"), `expected 1 excluded after quick-mode click, got: ${statsQuick}`);

  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  const statsToggleBack = await page.$eval("#stats", (el) => el.textContent);
  assert(statsToggleBack.includes("Excluded: 0"), `expected 0 excluded after toggling back, got: ${statsToggleBack}`);

  assertNoPageErrors(page);
  await browser.close();
});
