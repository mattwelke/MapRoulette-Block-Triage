const { launch, assertNoPageErrors, appUrl, fixturePath, assert, runTest } = require("./support");

runTest("combine: merge split pieces back, undo/redo, guard rails", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1500);

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  // Split the square into #0a/#0b first, so there's something to combine.
  await page.click(".feature-row");
  await page.waitForTimeout(300);
  await page.click("[data-split]");
  await page.waitForTimeout(300);
  const midY = mapBox.y + mapBox.height / 2;
  await page.mouse.click(mapBox.x + 5, midY);
  await page.waitForTimeout(150);
  await page.mouse.click(mapBox.x + mapBox.width - 5, midY);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "expected 2 pieces after splitting");

  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#combine-area-btn", (el) => el.textContent)).includes("Cancel"),
    "combine button should read Cancel while active"
  );

  const rows = await page.$$(".feature-row");
  await rows[0].click();
  await page.waitForTimeout(200);
  const rows2 = await page.$$(".feature-row"); // re-query - renderList() rebuilds the DOM
  await rows2[1].click();
  await page.waitForTimeout(200);

  const selectedCount = await page.$$eval(".feature-row.combine-selected", (els) => els.length);
  assert(selectedCount === 2, `expected 2 rows with combine-selected class, got ${selectedCount}`);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "combining should merge back to 1 area");
  const combinedLabel = await page.$eval(".feature-row .id", (el) => el.textContent);
  assert(
    combinedLabel === "#0a+0b" || combinedLabel === "#0b+0a",
    `expected combined id joining "0a" and "0b" in either order, got: ${combinedLabel}`
  );
  assert(
    (await page.$eval("#combine-area-btn", (el) => el.textContent)) === "Combine areas…",
    "combine button should reset its label after finishing"
  );
  assert(await page.$eval("#draw-status", (el) => el.hidden), "draw-status banner should hide after finishing combine");

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "undo should split the combined area back apart");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "redo should recombine");

  // Guard rail: attempting to combine with only 1 selected should refuse (via alert) and not change anything.
  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  await page.click(".feature-row");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "combining with only 1 selected should be a no-op");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert(await page.$eval("#draw-status", (el) => el.hidden), "Escape should cancel out of combine mode");

  assertNoPageErrors(page);
  await browser.close();
});
