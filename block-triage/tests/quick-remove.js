const { launch, assertNoPageErrors, localUrl, sampleDataPath, assert, runTest } = require("./support");

runTest("quick-remove: map-click toggling, popup carve-out", async () => {
  const { browser, page } = await launch();

  await page.goto(localUrl());
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

  await page.click("#quick-remove-checkbox");
  await page.waitForTimeout(200);
  assert(
    await page.$eval("#app", (el) => el.classList.contains("quick-remove-active")),
    "quick-remove-active class should apply once the checkbox is on"
  );

  const statsBefore = await page.$eval("#stats", (el) => el.textContent);
  const totalBefore = Number(statsBefore.match(/Total:\s*(\d+)/)[1]);

  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert((await page.$(".leaflet-popup")) === null, "quick mode: map click should NOT open a popup");
  const statsAfterRemove = await page.$eval("#stats", (el) => el.textContent);
  assert(
    statsAfterRemove.includes(`Total: ${totalBefore - 1}`),
    `expected the clicked area removed immediately (total ${totalBefore} -> ${totalBefore - 1}), got: ${statsAfterRemove}`
  );

  // Clicking that same spot again should draw a fresh area there via Add
  // new area, not "un-remove" it - quick-remove has no toggle-back, only
  // undo (see undo-redo.js). Verify undo brings the count back instead.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const statsAfterUndo = await page.$eval("#stats", (el) => el.textContent);
  assert(
    statsAfterUndo.includes(`Total: ${totalBefore}`),
    `expected undo to restore the removed area (back to ${totalBefore}), got: ${statsAfterUndo}`
  );

  assertNoPageErrors(page);
  await browser.close();
});
