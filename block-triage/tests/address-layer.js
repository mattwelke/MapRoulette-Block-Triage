const { launch, assertNoPageErrors, localUrl, sampleDataPath, assert, runTest } = require("./support");

runTest("address-layer: Oakville overlay toggles without crashing", async () => {
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
