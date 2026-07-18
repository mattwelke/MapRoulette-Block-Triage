const { launch, assertNoPageErrors, localUrl, fixturePath, assert, assertEqual, runTest } = require("./support");

runTest("reference-band: tessellated inner border, non-interactive, cleared on Clear", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(localUrl());
  await page.waitForTimeout(500);

  // The pattern <defs> should exist immediately, even before any reference file loads.
  const patternExists = await page.$eval("#map", (el) => !!el.querySelector("pattern#reference-tessellate-pattern"));
  assert(patternExists, "the tessellation pattern defs should be injected at startup");

  await page.click("#new-blank-btn");
  await page.waitForTimeout(300);
  await page.setInputFiles("#reference-file-input", fixturePath("reference.geojson"));
  await page.waitForTimeout(500);

  // The band only renders once zoomed in a lot (see reference-band-zoom.js) - this
  // fixture's overall extent (polygon + line + point) fits at a lower zoom than
  // that threshold, so zoom in a few steps to get into band-visible territory.
  for (let i = 0; i < 4; i++) {
    await page.click(".leaflet-control-zoom-in");
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);

  const bandPathCount = await page.$$eval('#map path[fill^="url(#reference-tessellate-pattern)"]', (els) => els.length);
  assert(bandPathCount >= 1, `expected at least 1 band path using the pattern fill once zoomed in, got ${bandPathCount}`);

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(300);
  assert((await page.$(".leaflet-popup")) === null, "the band overlay must be non-interactive");

  await page.click("#clear-reference-btn");
  await page.waitForTimeout(300);
  const bandPathCountAfterClear = await page.$$eval('#map path[fill^="url(#reference-tessellate-pattern)"]', (els) => els.length);
  assertEqual(bandPathCountAfterClear, 0, "Clear should remove the band along with the rest of the reference layer");

  assertNoPageErrors(page);
  await browser.close();
});
