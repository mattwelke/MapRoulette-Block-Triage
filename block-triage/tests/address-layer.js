const { launch, assertNoPageErrors, localUrl, liveUrl, sampleDataPath, assert, assertEqual, runTest } = require("./support");

runTest("address-layer: Oakville overlay toggles without crashing (local file triage)", async () => {
  const { browser, page } = await launch();

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(3000);

  await page.click(".leaflet-control-layers");
  await page.waitForTimeout(300);

  const checkboxes = await page.$$(".leaflet-control-layers-overlays input[type=checkbox]");
  assert(checkboxes.length >= 2, `expected at least 2 overlay checkboxes (address layer + reference layer), got ${checkboxes.length}`);

  await checkboxes[0].click();
  await page.waitForTimeout(1000);
  await checkboxes[0].click(); // toggle back off
  await page.waitForTimeout(300);

  // The main assertion is implicit: no pageerror listener fired above (see support.js).
  assert(true, "overlay toggled on and off without a page error");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("address-layer: Oakville overlay is also available in live MapRoulette editing", async () => {
  const { browser, page } = await launch();

  await page.goto(liveUrl());
  await page.waitForTimeout(500);

  await page.click(".leaflet-control-layers");
  await page.waitForTimeout(300);

  const overlayLabels = await page.$$eval(".leaflet-control-layers-overlays label", (els) => els.map((e) => e.textContent.trim()));
  assert(
    overlayLabels.some((l) => l.includes("Oakville addresses")),
    `expected an "Oakville addresses" overlay entry in live.html, got: ${JSON.stringify(overlayLabels)}`
  );

  const checkboxes = await page.$$(".leaflet-control-layers-overlays input[type=checkbox]");
  assertEqual(checkboxes.length, 2, `expected 2 overlay checkboxes (address layer + reference layer), got ${checkboxes.length}`);
  await checkboxes[0].click();
  await page.waitForTimeout(1000);
  await checkboxes[0].click(); // toggle back off
  await page.waitForTimeout(300);

  assertNoPageErrors(page);
  await browser.close();
});
