const { launch, assertNoPageErrors, indexUrl, sampleDataPath, assert, runTest } = require("./support");

runTest("undo-redo: keyboard shortcuts, buttons, quick-exclude accident recovery", async () => {
  const { browser, page } = await launch();

  await page.goto(indexUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);

  assert(await page.$eval("#undo-btn", (el) => el.disabled), "undo should be disabled with no actions yet");

  await page.click(".feature-row");
  await page.waitForTimeout(300);
  await page.keyboard.press("x");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Excluded: 1"), "expected 1 excluded after x");
  assert(!(await page.$eval("#undo-btn", (el) => el.disabled)), "undo should be enabled after an action");

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Excluded: 0"), "Ctrl+Z should undo the exclude");
  assert(!(await page.$eval("#redo-btn", (el) => el.disabled)), "redo should be enabled after an undo");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Excluded: 1"), "Ctrl+Shift+Z should redo the exclude");

  await page.click("#undo-btn");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Excluded: 0"), "Undo button should undo the redo");
  assert(await page.$eval("#undo-btn", (el) => el.disabled), "undo should be disabled once history is empty again");

  // Quick-exclude mode: an accidental click should still be undoable.
  await page.click("#quick-exclude-checkbox");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Excluded: 1"), "quick-exclude click should exclude");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Excluded: 0"),
    "undo should recover from an accidental quick-exclude click"
  );

  assertNoPageErrors(page);
  await browser.close();
});
