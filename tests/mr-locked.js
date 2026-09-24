const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90001;

runTest("mr-locked: already-resolved (Fixed/Already_Fixed) tasks are locked", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Row #3 is Fixed by fixture design (see mrChallengeSampleTasks).
  const rows = await page.$$(".feature-row");
  await rows[3].click();
  await page.waitForTimeout(300);

  const popupHtml = await page.$eval(".leaflet-popup-content", (el) => el.innerHTML);
  assert(popupHtml.includes("mr-locked-note"), "locked popup should show the lock note");
  assert(!popupHtml.includes("data-split"), "locked popup should omit the Split button");
  assert(!popupHtml.includes("data-mr-action"), "locked popup should omit the mr-action button");
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
