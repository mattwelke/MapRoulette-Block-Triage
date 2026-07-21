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

function visible(page, selector) {
  return page.$eval(selector, (el) => getComputedStyle(el).display !== "none");
}

runTest("chrome-minimize: hides the topbar/sidebar entirely, floating four icon actions over the map, and persists across reloads", async () => {
  const { browser, page } = await launch();

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());
  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Not minimized by default.
  assert(await visible(page, "#topbar"), "topbar should be visible by default");
  assert(await visible(page, "#sidebar"), "sidebar should be visible by default");
  assert(!(await visible(page, "#mini-toolbar")), "the floating toolbar should be hidden by default");
  assertEqual(await page.$eval("#chrome-toggle-btn", (el) => el.textContent), "Minimize");

  await page.click("#chrome-toggle-btn");
  await page.waitForTimeout(200);

  assert(!(await visible(page, "#topbar")), "the whole topbar should be hidden once minimized, not just shrunk");
  assert(!(await visible(page, "#sidebar")), "sidebar should be hidden once minimized");
  assert(await visible(page, "#mini-toolbar"), "the floating toolbar should appear once minimized");

  // The floating toolbar sits over the map, not inside a bar of its own.
  const toolbarBox = await page.$eval("#mini-toolbar", (el) => el.getBoundingClientRect());
  const mapBox = await page.$eval("#map", (el) => el.getBoundingClientRect());
  assert(toolbarBox.top >= mapBox.top - 5, "the floating toolbar should sit within/over the map area, not above it in a separate bar");
  for (const id of ["#mini-add-area-btn", "#mini-combine-area-btn", "#mini-process-all-btn", "#mini-expand-btn"]) {
    const box = await page.$eval(id, (el) => el.getBoundingClientRect());
    assert(box.width < 60 && box.height < 60, `expected ${id} to be a small icon-square button, got ${box.width}x${box.height}`);
  }

  // Reload - the minimized state should persist via localStorage.
  await page.reload();
  await page.waitForTimeout(300);
  assert(!(await visible(page, "#topbar")), "topbar should still be hidden after a reload");
  assert(await visible(page, "#mini-toolbar"), "the floating toolbar should still show after a reload");

  // Un-minimize via the floating toolbar's own expand button.
  await page.click("#mini-expand-btn");
  await page.waitForTimeout(200);
  assert(await visible(page, "#topbar"), "topbar should be visible again after expanding");
  assert(await visible(page, "#sidebar"), "sidebar should be visible again after expanding");
  assert(!(await visible(page, "#mini-toolbar")), "the floating toolbar should hide again once expanded");
  assertEqual(await page.$eval("#chrome-toggle-btn", (el) => el.textContent), "Minimize");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("chrome-minimize: the floating buttons forward to the real ones and stay in sync with their disabled state", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());
  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Queue something first, while the sidebar/popup are still reachable
  // (the sidebar's feature list is hidden once minimized).
  const rows = await page.$$(".feature-row");
  await rows[0].click();
  await page.waitForTimeout(200);
  await page.click("[data-mr-action]"); // "Remove task from challenge" - queues a delete
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  await page.click("#chrome-toggle-btn");
  await page.waitForTimeout(200);

  // Clicking the floating add-area button should enter drawing mode, same
  // as the real (now hidden) button would.
  await page.click("#mini-add-area-btn");
  await page.waitForTimeout(200);
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "clicking the floating button should still enter draw mode");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (1)",
    "the real button should reflect the queued delete"
  );
  assert(!(await page.$eval("#mini-process-all-btn", (el) => el.disabled)), "the floating button should be enabled once something is queued");

  await page.click("#mini-process-all-btn");
  await page.waitForTimeout(1500);

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (0)",
    "processing via the floating button should actually run the real one"
  );
  assert(await page.$eval("#mini-process-all-btn", (el) => el.disabled), "the floating button should go back to disabled once the queue is empty");

  assertNoPageErrors(page);
  await browser.close();
});
