const { launch, assertNoPageErrors, indexUrl, fixturePath, assert, assertEqual, runTest } = require("./support");

runTest("mr-locked: already-resolved (Fixed/Already_Fixed) tasks are locked", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto(indexUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

  // Row #3 is Fixed by fixture design.
  const rows = await page.$$(".feature-row");
  await rows[3].click();
  await page.waitForTimeout(300);

  const popupHtml = await page.$eval(".leaflet-popup-content", (el) => el.innerHTML);
  assert(popupHtml.includes("mr-locked-note"), "locked popup should show the lock note");
  assert(!popupHtml.includes("data-split"), "locked popup should omit the Split button");
  assert(!popupHtml.includes("data-mr-action"), "locked popup should omit the mr-action button, even with live sync on");

  // Exclude/Keep/Reset are purely local and should still work.
  await page.click('[data-action="excluded"]');
  await page.waitForTimeout(200);
  assertEqual(await page.$eval("[data-status]", (el) => el.textContent), "excluded", "Exclude should still work on a locked entry");
  await page.click('[data-action="unreviewed"]');
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);

  // Combine-select should refuse a locked entry.
  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  const preCombineDialogCount = dialogs.length;
  const rows2 = await page.$$(".feature-row");
  await rows2[3].click();
  await page.waitForTimeout(200);
  assert(dialogs.length > preCombineDialogCount, "combine-selecting a locked row should trigger an alert");
  assert(dialogs[dialogs.length - 1].includes("locked"), `expected a locked-related alert, got: ${dialogs[dialogs.length - 1]}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Quick queue-delete mode should refuse a locked entry too (map click).
  await page.click("#mr-quick-queue-checkbox");
  await page.waitForTimeout(200);
  const rows3 = await page.$$(".feature-row");
  await rows3[3].click(); // pan the map to it
  await page.waitForTimeout(300);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const preQueueDialogCount = dialogs.length;
  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert(dialogs.length > preQueueDialogCount, "quick-queue map click on a locked area should alert, not queue");
  assertEqual(await page.$eval("#mr-queue-btn", (el) => el.textContent), "Process delete queue (0)", "nothing should get queued");

  assertNoPageErrors(page);
  await browser.close();
});
