const { launch, assertNoPageErrors, appUrl, fixturePath, assert, runTest } = require("./support");

runTest("reference-band-zoom: band only renders past the zoom threshold", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.click("#new-blank-btn");
  await page.waitForTimeout(300);
  await page.setInputFiles("#reference-file-input", fixturePath("reference.geojson"));
  await page.waitForTimeout(500);

  const bandCount = async () => page.$$eval('#map path[fill^="url(#reference-tessellate-pattern)"]', (els) => els.length);

  // Establish a definitely-zoomed-in baseline first - this fixture's overall
  // extent (polygon + line + point) doesn't necessarily fit past the band's
  // zoom threshold right after fitBounds, so don't assume it does.
  for (let i = 0; i < 6; i++) {
    await page.click(".leaflet-control-zoom-in");
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  const zoomedInCount = await bandCount();
  assert(zoomedInCount >= 1, `expected the band visible once zoomed in past the threshold, got ${zoomedInCount}`);

  for (let i = 0; i < 8; i++) {
    await page.click(".leaflet-control-zoom-out");
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  const zoomedOutCount = await bandCount();
  assert(zoomedOutCount === 0, `expected the band hidden once zoomed out past the threshold, got ${zoomedOutCount} paths`);

  for (let i = 0; i < 8; i++) {
    await page.click(".leaflet-control-zoom-in");
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  const zoomedBackInCount = await bandCount();
  assert(zoomedBackInCount >= 1, `expected the band to reappear after zooming back in, got ${zoomedBackInCount}`);

  assert(
    (await page.$eval("#reference-file-name", (el) => el.textContent)).includes("reference.geojson"),
    "sanity: the main reference layer should still be loaded throughout"
  );

  assertNoPageErrors(page);
  await browser.close();
});
