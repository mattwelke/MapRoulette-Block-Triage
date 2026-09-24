const { launch, assertNoPageErrors, localUrl, sampleDataPath, assert, runTest } = require("./support");

runTest("undo-redo: keyboard shortcuts, buttons, quick-remove accident recovery", async () => {
  const { browser, page } = await launch();

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);

  assert(await page.$eval("#undo-btn", (el) => el.disabled), "undo should be disabled with no actions yet");

  const statsBefore = await page.$eval("#stats", (el) => el.textContent);
  const totalBefore = Number(statsBefore.match(/Total:\s*(\d+)/)[1]);

  await page.click(".feature-row");
  await page.waitForTimeout(300);
  await page.keyboard.press("x");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${totalBefore - 1}`),
    "expected 1 feature removed after x"
  );
  assert(!(await page.$eval("#undo-btn", (el) => el.disabled)), "undo should be enabled after an action");

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${totalBefore}`),
    "Ctrl+Z should undo the removal"
  );
  assert(!(await page.$eval("#redo-btn", (el) => el.disabled)), "redo should be enabled after an undo");

  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${totalBefore - 1}`),
    "Ctrl+Shift+Z should redo the removal"
  );

  await page.click("#undo-btn");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${totalBefore}`),
    "Undo button should undo the redo"
  );
  assert(await page.$eval("#undo-btn", (el) => el.disabled), "undo should be disabled once history is empty again");

  // Quick-remove mode: an accidental click should still be undoable.
  await page.click("#quick-remove-checkbox");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${totalBefore - 1}`),
    "quick-remove click should remove the area"
  );
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${totalBefore}`),
    "undo should recover from an accidental quick-remove click"
  );

  assertNoPageErrors(page);
  await browser.close();
});
