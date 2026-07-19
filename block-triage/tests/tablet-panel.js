const {
  launch,
  assertNoPageErrors,
  localUrl,
  liveUrl,
  fixturePath,
  assert,
  runTest,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const TABLET_VIEWPORT = { width: 1024, height: 768 }; // landscape, within the tablet range
const DESKTOP_VIEWPORT = { width: 1400, height: 900 }; // outside the tablet range

runTest("tablet-panel: local file triage shows the fixed panel on tablet viewports, a normal popup elsewhere", async () => {
  const { browser, page } = await launch({ viewport: TABLET_VIEWPORT });

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1000);

  await page.click(".feature-row");
  await page.waitForTimeout(300);

  assert((await page.$(".leaflet-popup")) === null, "a tablet viewport should not open a Leaflet popup");
  assert(!(await page.$eval("#tablet-panel", (el) => el.hidden)), "the fixed tablet panel should be visible instead");
  assert(
    (await page.$eval("#tablet-panel-content", (el) => el.textContent)).includes("Feature #"),
    "the tablet panel should contain the area's details"
  );

  const panelBox = await page.$eval("#tablet-panel", (el) => el.getBoundingClientRect());
  const viewportWidth = TABLET_VIEWPORT.width;
  const viewportHeight = TABLET_VIEWPORT.height;
  assert(
    panelBox.right > viewportWidth - 40,
    `expected the panel pinned near the right edge (viewport width ${viewportWidth}), got right=${panelBox.right}`
  );
  const panelCenterY = (panelBox.top + panelBox.bottom) / 2;
  assert(
    Math.abs(panelCenterY - viewportHeight / 2) < 40,
    `expected the panel roughly vertically centered (viewport height ${viewportHeight}), got center=${panelCenterY}`
  );

  // Closing via the panel's own close button.
  await page.click("#tablet-panel-close");
  await page.waitForTimeout(200);
  assert(await page.$eval("#tablet-panel", (el) => el.hidden), "the close button should hide the panel");

  // Reopen, then close by tapping empty map background. Zoom out a few
  // times first so the one drawn feature shrinks away from the corner.
  await page.click(".feature-row");
  await page.waitForTimeout(300);
  assert(!(await page.$eval("#tablet-panel", (el) => el.hidden)), "the panel should reopen for a second tap");
  await page.click(".leaflet-control-zoom-out");
  await page.click(".leaflet-control-zoom-out");
  await page.click(".leaflet-control-zoom-out");
  await page.click(".leaflet-control-zoom-out");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    // Bottom-left: away from the top-left zoom control and clear of the
    // single drawn feature now that we've zoomed out a few times.
    return { x: r.x + 15, y: r.y + r.height - 15 };
  });
  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(200);
  assert(await page.$eval("#tablet-panel", (el) => el.hidden), "tapping empty map background should close the panel");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("tablet-panel: a normal (non-tablet) viewport still gets an ordinary Leaflet popup", async () => {
  const { browser, page } = await launch({ viewport: DESKTOP_VIEWPORT });

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1000);

  await page.click(".feature-row");
  await page.waitForTimeout(300);

  assert((await page.$(".leaflet-popup")) !== null, "a non-tablet viewport should open a normal Leaflet popup");
  assert(await page.$eval("#tablet-panel", (el) => el.hidden), "the fixed tablet panel should stay hidden outside the tablet range");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("tablet-panel: live MapRoulette editing also uses the fixed panel on tablet viewports", async () => {
  const { browser, page } = await launch({ viewport: TABLET_VIEWPORT });
  page.on("dialog", async (dialog) => await dialog.accept());

  const CHALLENGE_ID = 90001;
  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await page.click(".feature-row");
  await page.waitForTimeout(300);

  assert((await page.$(".leaflet-popup")) === null, "a tablet viewport should not open a Leaflet popup in live mode either");
  assert(!(await page.$eval("#tablet-panel", (el) => el.hidden)), "the fixed tablet panel should show the tapped area's details");
  assert(
    (await page.$eval("#tablet-panel-content", (el) => el.textContent)).includes("Feature #"),
    "the tablet panel should contain the area's details"
  );

  assertNoPageErrors(page);
  await browser.close();
});
