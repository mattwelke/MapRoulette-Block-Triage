const fs = require("fs");
const { launch, assertNoPageErrors, indexUrl, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("blank-start: New (blank) session, draw-from-scratch, confirm-before-discard", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(indexUrl());
  await page.waitForTimeout(500);

  assert(await page.$eval("#export-btn", (el) => el.disabled), "export should start disabled with nothing loaded");
  assert(await page.$eval("#add-area-btn", (el) => el.disabled), "add-area should start disabled with nothing loaded");

  await page.click("#new-blank-btn");
  await page.waitForTimeout(300);
  assert(!(await page.$eval("#export-btn", (el) => el.disabled)), "export should enable after New (blank)");
  assert(!(await page.$eval("#add-area-btn", (el) => el.disabled)), "add-area should enable after New (blank)");
  assertEqual(
    (await page.$eval("#stats", (el) => el.textContent)).replace(/\s+/g, " ").trim(),
    "Total: 0 Unreviewed: 0 Flagged, undecided: 0 Excluded: 0 Kept: 0",
    "a blank session should start with zero features"
  );

  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const pts = [
    { x: mapBox.x + 300, y: mapBox.y + 200 },
    { x: mapBox.x + 500, y: mapBox.y + 200 },
    { x: mapBox.x + 400, y: mapBox.y + 400 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 1"), "expected 1 feature after drawing from scratch");

  const downloadPath = tmpPath("from-scratch.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, 1, "exported file should carry the one drawn feature");
  assertEqual(exported.features[0].geometry.type, "Polygon", "drawn feature should be a Polygon");

  // New (blank) again with existing entries should discard them (dialog auto-accepted above).
  await page.click("#new-blank-btn");
  await page.waitForTimeout(300);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 0"), "starting a new blank session should discard prior areas");

  assertNoPageErrors(page);
  await browser.close();
});
