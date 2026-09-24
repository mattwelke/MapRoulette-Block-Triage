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

const TABLET_VIEWPORT = { width: 1024, height: 768 }; // landscape, touch
// Wider than the app's old (now-removed) 1366px width cap - e.g. a 13"+
// tablet in landscape, whose CSS
// viewport width exceeds older tablets like the 12.9" iPad Pro. Tablet mode
// is now detected by touch capability rather than a width range specifically
// so devices like this aren't excluded just for being physically larger.
const LARGE_TABLET_VIEWPORT = { width: 1440, height: 900 };
const DESKTOP_VIEWPORT = { width: 1400, height: 900 }; // mouse/trackpad, no touch

runTest("tablet-panel: local file triage shows the fixed panel on tablet viewports, a normal popup elsewhere", async () => {
  const { browser, page } = await launch({ viewport: TABLET_VIEWPORT, hasTouch: true });

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

runTest("tablet-panel: a normal (non-touch) viewport still gets an ordinary Leaflet popup, even at a tablet-ish width", async () => {
  const { browser, page } = await launch({ viewport: DESKTOP_VIEWPORT });

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1000);

  await page.click(".feature-row");
  await page.waitForTimeout(300);

  assert((await page.$(".leaflet-popup")) !== null, "a non-touch viewport should open a normal Leaflet popup");
  assert(await page.$eval("#tablet-panel", (el) => el.hidden), "the fixed tablet panel should stay hidden without touch, regardless of width");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("tablet-panel: a large (13\"+) touch tablet still gets the fixed panel, not the desktop popup", async () => {
  // Regression test for a real bug report: a 13" tablet rendered in
  // desktop style instead of tablet style, because
  // tablet mode used to be a pure width range capped at 1366px (tuned to
  // the 12.9" iPad Pro) - a physically larger tablet's landscape CSS width
  // exceeded that cap and fell through to desktop styling. Detecting touch
  // capability instead of a width ceiling fixes this for any current or
  // future large tablet, not just this one model.
  const { browser, page } = await launch({ viewport: LARGE_TABLET_VIEWPORT, hasTouch: true });

  await page.goto(localUrl());
  await page.waitForTimeout(500);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1000);

  await page.click(".feature-row");
  await page.waitForTimeout(300);

  assert((await page.$(".leaflet-popup")) === null, "a large touch tablet should not open a Leaflet popup");
  assert(!(await page.$eval("#tablet-panel", (el) => el.hidden)), "the fixed tablet panel should be visible on a large touch tablet too");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("tablet-panel: live MapRoulette editing also uses the fixed panel on tablet viewports", async () => {
  const { browser, page } = await launch({ viewport: TABLET_VIEWPORT, hasTouch: true });
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
