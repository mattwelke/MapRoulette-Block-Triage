const fs = require("fs");
const { launch, assertNoPageErrors, indexUrl, fixturePath, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("reference-layer: non-interactive overlay, never in stats/export", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(indexUrl());
  await page.waitForTimeout(500);
  assert(await page.$eval("#clear-reference-btn", (el) => el.disabled), "clear-reference should start disabled");

  await page.click("#new-blank-btn");
  await page.waitForTimeout(300);
  await page.setInputFiles("#reference-file-input", fixturePath("reference.geojson"));
  await page.waitForTimeout(500);

  assert(
    (await page.$eval("#reference-file-name", (el) => el.textContent)).includes("reference.geojson"),
    "reference-file-name should show the loaded file"
  );
  assert(!(await page.$eval("#clear-reference-btn", (el) => el.disabled)), "clear-reference should enable after load");

  await page.click(".leaflet-control-layers");
  await page.waitForTimeout(300);
  const overlayLabels = await page.$$eval(".leaflet-control-layers-overlays label", (els) => els.map((e) => e.textContent.trim()));
  assert(
    overlayLabels.some((l) => l.includes("Reference layer")),
    `expected a "Reference layer" overlay entry, got: ${overlayLabels}`
  );

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 0"), "reference layer must not count toward stats");

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(300);
  assert((await page.$(".leaflet-popup")) === null, "reference layer must be non-interactive - no popup on click");

  // Draw a working area right over the reference layer - clicks must pass through to drawing.
  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  const pts = [
    { x: mapBox.x + mapBox.width / 2 - 60, y: mapBox.y + mapBox.height / 2 - 60 },
    { x: mapBox.x + mapBox.width / 2 + 60, y: mapBox.y + mapBox.height / 2 - 60 },
    { x: mapBox.x + mapBox.width / 2, y: mapBox.y + mapBox.height / 2 + 60 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "drawing over the reference layer should still work");

  const downloadPath = tmpPath("reference-layer-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, 1, "export should carry only the drawn working area, never reference features");

  await page.click("#clear-reference-btn");
  await page.waitForTimeout(300);
  assertEqual(await page.$eval("#reference-file-name", (el) => el.textContent), "No reference layer", "clear should reset the label");
  assert(await page.$eval("#clear-reference-btn", (el) => el.disabled), "clear-reference should disable again after clearing");

  assertNoPageErrors(page);
  await browser.close();
});
