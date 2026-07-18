const fs = require("fs");
const { launch, assertNoPageErrors, appUrl, fixturePath, tmpPath, assert, assertEqual, runTest } = require("./support");

runTest("maproulette-basic: API key persistence, challenge auto-detect, add/remove labels, export round-trip", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);

  assertEqual(await page.$eval("#mr-api-key-input", (el) => el.value), "", "API key input should start empty");

  await page.click("#mr-test-btn");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#mr-status", (el) => el.textContent)).length > 0,
    "clicking Test connection with no API key should show a client-side message"
  );

  await page.fill("#mr-api-key-input", "fake-test-key-123");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(100);

  await page.reload();
  await page.waitForTimeout(500);
  assertEqual(
    await page.$eval("#mr-api-key-input", (el) => el.value),
    "fake-test-key-123",
    "API key should persist across a reload via localStorage"
  );

  await page.click("#mr-api-key-clear-btn");
  await page.waitForTimeout(200);
  assertEqual(await page.$eval("#mr-api-key-input", (el) => el.value), "", "Clear should empty the API key input");
  await page.reload();
  await page.waitForTimeout(500);
  assertEqual(await page.$eval("#mr-api-key-input", (el) => el.value), "", "cleared API key should stay empty after reload");

  // Re-enable live sync (reload reset the checkbox state's DOM, though the
  // underlying localStorage flag persisted) and load the synthetic challenge fixture.
  const liveSyncOn = await page.$eval("#mr-live-sync-checkbox", (el) => el.checked);
  if (!liveSyncOn) await page.click("#mr-live-sync-checkbox");
  await page.fill("#mr-api-key-input", "fake-test-key-123");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

  assertEqual(
    await page.$eval("#mr-challenge-id-input", (el) => el.value),
    "90001",
    "challenge ID should auto-detect from the loaded file's mr_challengeId"
  );
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"), "expected the 10-feature fixture to load");

  // Row #0 is unlocked and task-linked by design (see the fixture generator) -
  // its popup should offer "Remove task from challenge".
  const rows = await page.$$(".feature-row");
  await rows[0].click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "a loaded, task-linked, unlocked feature should offer Remove"
  );

  // Queue it (no network call happens until "Process delete queue").
  await page.click("[data-mr-action]");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("[data-mr-status]", (el) => el.textContent)).toLowerCase().includes("queued"),
    "clicking Remove should queue it, not delete immediately"
  );
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending removal",
    "button should flip to Cancel pending removal once queued"
  );
  await page.click("[data-mr-action]"); // dequeue again, don't actually leave it queued for the rest of this test
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});

  // Draw a new area from scratch - its popup should offer "Add task to challenge".
  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const pts = [
    { x: mapBox.x + 300, y: mapBox.y + 250 },
    { x: mapBox.x + 500, y: mapBox.y + 250 },
    { x: mapBox.x + 400, y: mapBox.y + 450 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  const rowsAfterAdd = await page.$$(".feature-row");
  let newAreaRow = null;
  for (const row of rowsAfterAdd) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label.includes("new-")) {
      newAreaRow = row;
      break;
    }
  }
  assert(!!newAreaRow, "expected a freshly-drawn new-N area in the list");
  await newAreaRow.click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Add task to challenge",
    "a freshly-drawn, unlinked area should offer Add"
  );

  const downloadPath = tmpPath("maproulette-basic-export.geojson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  await download.saveAs(downloadPath);
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  assertEqual(exported.features.length, 11, "export should carry the original 10 plus the new area");
  const withTaskId = exported.features.filter((f) => f.properties && f.properties.mr_taskId).length;
  assertEqual(withTaskId, 10, "the 10 original features should still carry mr_taskId; the new one should not");

  assertNoPageErrors(page);
  await browser.close();
});
