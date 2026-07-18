const { launch, assertNoPageErrors, appUrl, fixturePath, assert, runTest } = require("./support");

runTest("split-add: split, add-new-area, undo/redo, cancel mid-draw", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1500);

  await page.click(".feature-row");
  await page.waitForTimeout(300);
  await page.click("[data-split]");
  await page.waitForTimeout(300);
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "draw-status should be visible once Split is clicked");

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const midY = mapBox.y + mapBox.height / 2;
  await page.mouse.click(mapBox.x + 5, midY);
  await page.waitForTimeout(150);
  await page.mouse.click(mapBox.x + mapBox.width - 5, midY);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "a full-width cut should split into 2 pieces");
  let rowLabels = await page.$$eval(".feature-row .id", (els) => els.map((e) => e.textContent));
  assert(rowLabels.includes("#0a") && rowLabels.includes("#0b"), `expected split pieces #0a/#0b, got: ${rowLabels}`);
  assert(await page.$eval("#draw-status", (el) => el.hidden), "draw-status should hide once the split finishes");

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "undo should restore the original single area");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "redo should reapply the split");

  // --- Add new area ---
  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  const addBtnLabel = await page.$eval("#add-area-btn", (el) => el.textContent);
  assert(addBtnLabel.includes("Cancel"), `add-area button should read "Cancel adding..." while drawing, got: ${addBtnLabel}`);

  const p1 = { x: mapBox.x + 300, y: mapBox.y + 200 };
  const p2 = { x: mapBox.x + 500, y: mapBox.y + 200 };
  const p3 = { x: mapBox.x + 400, y: mapBox.y + 400 };
  for (const p of [p1, p2, p3]) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 3"), "adding a new area should bring the total to 3");
  rowLabels = await page.$$eval(".feature-row .id", (els) => els.map((e) => e.textContent));
  assert(rowLabels.some((l) => l.startsWith("#new-")), `expected a synthetic "new-N" id among ${rowLabels}`);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "undo should remove the newly-added area");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 3"), "redo should re-add it");

  // --- Cancel mid-draw sanity check ---
  await page.click("#add-area-btn");
  await page.waitForTimeout(150);
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(100);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert(await page.$eval("#draw-status", (el) => el.hidden), "Escape should cancel drawing and hide draw-status");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 3"), "canceling a draw should not change the total");

  assertNoPageErrors(page);
  await browser.close();
});
