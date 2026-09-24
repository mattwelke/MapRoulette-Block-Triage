const { launch, assertNoPageErrors, localUrl, sampleDataPath, assert, assertEqual, runTest } = require("./support");

runTest("selection-pulse: the selected area gets an animated CSS pulse", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", sampleDataPath("blocks.geojson"));
  await page.waitForTimeout(4000);

  assertEqual((await page.$$(".selection-pulse")).length, 0, "no pulse before any selection");

  await page.click(".feature-row");
  await page.waitForTimeout(300);
  assertEqual((await page.$$(".selection-pulse")).length, 1, "exactly one pulse element after selecting a feature");

  const animInfo = await page.$eval(".selection-pulse", (el) => {
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, animationIterationCount: cs.animationIterationCount };
  });
  assertEqual(animInfo.animationName, "selection-pulse", "the pulse element should have the selection-pulse animation applied");
  assertEqual(animInfo.animationIterationCount, "infinite", "the pulse should loop indefinitely, not run once");

  const opacityAt = async () => page.$eval(".selection-pulse", (el) => getComputedStyle(el).opacity);
  const o1 = await opacityAt();
  await page.waitForTimeout(900); // ~half of the 1.8s period
  const o2 = await opacityAt();
  assert(o1 !== o2, `opacity should change over time (sampled ~0.9s apart): ${o1} -> ${o2}`);

  const rows = await page.$$(".feature-row");
  await rows[1].click();
  await page.waitForTimeout(300);
  assertEqual((await page.$$(".selection-pulse")).length, 1, "still exactly one pulse element after selecting a different row");

  await page.click("#new-blank-btn");
  await page.waitForTimeout(300);
  assertEqual((await page.$$(".selection-pulse")).length, 0, "the pulse should be removed once selection is cleared by a new session");

  assertNoPageErrors(page);
  await browser.close();
});
