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

runTest("chrome-minimize: collapses the sidebar/topbar to three icon actions, and persists across reloads", async () => {
  const { browser, page } = await launch();

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());
  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Not minimized by default.
  assert(await visible(page, "#sidebar"), "sidebar should be visible by default");
  assertEqual(await page.$eval("#chrome-toggle-btn", (el) => el.textContent), "Minimize");

  await page.click("#chrome-toggle-btn");
  await page.waitForTimeout(200);

  assert(!(await visible(page, "#sidebar")), "sidebar should be hidden once minimized");
  assert(!(await visible(page, "#topbar h1")), "the page title should be hidden once minimized");
  assert(!(await visible(page, "#undo-btn")), "Undo should be hidden once minimized");
  assert(!(await visible(page, "#replace-area-btn")), "Replace areas should be hidden once minimized (only add/combine/sync persist)");
  assert(!(await visible(page, "#theme-toggle-btn")), "the theme toggle should be hidden once minimized");

  assert(await visible(page, "#add-area-btn"), "Add new area should still be visible, as a small icon");
  assert(await visible(page, "#combine-area-btn"), "Combine areas should still be visible, as a small icon");
  assert(await visible(page, "#mini-process-all-btn"), "the process-all icon button should be visible once minimized");
  assertEqual(await page.$eval("#chrome-toggle-btn", (el) => el.textContent), "Show UI");

  // The icon buttons should render as small squares, not full-width text
  // buttons - and their real (JS-managed) text should be visually hidden
  // in favor of the CSS ::before icon.
  const addBox = await page.$eval("#add-area-btn", (el) => el.getBoundingClientRect());
  assert(addBox.width < 60 && addBox.height < 60, `expected a small icon-square button, got ${addBox.width}x${addBox.height}`);
  const addFontSize = await page.$eval("#add-area-btn", (el) => getComputedStyle(el).fontSize);
  assertEqual(addFontSize, "0px", "the button's own text should collapse to invisible so only the ::before icon shows");

  // Reload - the minimized state should persist via localStorage.
  await page.reload();
  await page.waitForTimeout(300);
  assert(!(await visible(page, "#sidebar")), "sidebar should still be hidden after a reload");
  assertEqual(await page.$eval("#chrome-toggle-btn", (el) => el.textContent), "Show UI");

  // Un-minimize.
  await page.click("#chrome-toggle-btn");
  await page.waitForTimeout(200);
  assert(await visible(page, "#sidebar"), "sidebar should be visible again after un-minimizing");
  assert(await visible(page, "#replace-area-btn"), "Replace areas should be visible again after un-minimizing");
  assertEqual(await page.$eval("#chrome-toggle-btn", (el) => el.textContent), "Minimize");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("chrome-minimize: the icon buttons still work and the process-all icon stays in sync with its full-size counterpart", async () => {
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

  // Clicking the (still-functional) add-area icon button should enter
  // drawing mode, same as the full-size button would.
  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "clicking the icon button should still enter draw mode");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (1)",
    "the full-size button should reflect the queued delete"
  );
  assert(!(await page.$eval("#mini-process-all-btn", (el) => el.disabled)), "the icon button should be enabled once something is queued");

  await page.click("#mini-process-all-btn");
  await page.waitForTimeout(1500);

  assertEqual(
    await page.$eval("#mr-process-all-btn", (el) => el.textContent),
    "Process all pending (0)",
    "processing via the icon button should actually run it, same as the full-size one"
  );
  assert(await page.$eval("#mini-process-all-btn", (el) => el.disabled), "the icon button should go back to disabled once the queue is empty");

  assertNoPageErrors(page);
  await browser.close();
});
