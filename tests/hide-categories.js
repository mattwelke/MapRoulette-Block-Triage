const {
  launch,
  assert,
  assertEqual,
  assertNoPageErrors,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
  liveUrl,
} = require("./support");

const CHALLENGE_ID = 90120;

function square(offset) {
  const x = -79.8 + offset;
  return {
    type: "Polygon",
    coordinates: [
      [
        [x, 43.45],
        [x + 0.01, 43.45],
        [x + 0.01, 43.46],
        [x, 43.46],
        [x, 43.45],
      ],
    ],
  };
}

async function listRows(page) {
  return page.$$eval(".feature-row", (rows) =>
    rows.map((r) => ({ id: r.dataset.id, statusDotClass: r.querySelector(".status-dot").className }))
  );
}

runTest("hide-categories: checking a category hides its areas from both the sidebar list and the map", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [
    makeMrTask(601, square(0), "Created"), // normal-ish, depends on size - will be oversized/undersized by default threshold
    makeMrTask(602, square(1), "Too_Hard"), // could-not-complete
  ]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  const before = await listRows(page);
  assertEqual(before.length, 2, "sanity: both areas should be listed before hiding anything");
  const couldNotCompleteRow = before.find((r) => r.statusDotClass.includes("could-not-complete"));
  assert(couldNotCompleteRow, "sanity: one area should be could-not-complete");

  await page.click('[data-hide-category="could-not-complete"]');
  await page.waitForTimeout(200);

  const afterHide = await listRows(page);
  assertEqual(afterHide.length, 1, "hiding could-not-complete should drop it from the sidebar list");
  assert(!afterHide.some((r) => r.statusDotClass.includes("could-not-complete")), "the hidden area shouldn't appear in the list at all");

  assertEqual(
    await page.$eval('[data-count="could-not-complete"]', (el) => el.textContent),
    "1",
    "the count next to the checkbox should still reflect the true total, unaffected by hiding"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("hide-categories: unchecking restores hidden areas to the list", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(601, square(0), "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await page.click('[data-hide-category="could-not-complete"]');
  await page.waitForTimeout(200);
  assertEqual((await listRows(page)).length, 0, "sanity: the only area should be hidden");

  await page.click('[data-hide-category="could-not-complete"]');
  await page.waitForTimeout(200);
  assertEqual((await listRows(page)).length, 1, "unchecking should bring the area back");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("hide-categories: a hidden area's map layer stops swallowing clicks", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(601, square(0), "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // The working areas render on a canvas (see preferCanvas in live.js), not
  // as individual SVG <path> elements, so there's no per-feature DOM node to
  // click - click through the map container at the spot the area was just
  // panned/zoomed to fit, the same way the app's own mouse-driven tests do.
  await page.click(".feature-row");
  await page.waitForTimeout(300);
  assert(!!(await page.$(".leaflet-popup")), "sanity: clicking the sidebar row should open a popup and pan/zoom the area into view");
  await page.click(".leaflet-popup-close-button");
  await page.waitForTimeout(200);

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const center = { x: mapBox.x + mapBox.width / 2, y: mapBox.y + mapBox.height / 2 };

  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(300);
  assert(!!(await page.$(".leaflet-popup")), "sanity: clicking the area's own canvas-rendered layer (now centered) should open its popup while visible");
  await page.click(".leaflet-popup-close-button");
  await page.waitForTimeout(200);

  await page.click('[data-hide-category="could-not-complete"]');
  await page.waitForTimeout(200);

  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(300);
  assert(!(await page.$(".leaflet-popup")), "clicking the same spot shouldn't open a popup once its area's category is hidden");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("hide-categories: the checked set persists across a reload via localStorage", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [makeMrTask(601, square(0), "Too_Hard")]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await page.click('[data-hide-category="could-not-complete"]');
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForTimeout(500);

  assert(
    await page.$eval('[data-hide-category="could-not-complete"]', (el) => el.checked),
    "the checkbox should stay checked after a reload"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("hide-categories: stats totals are unaffected by hiding, and locked/checked-out/could-not-complete each get their own count", async () => {
  const { browser, page } = await launch();
  await routeMrChallenge(page, CHALLENGE_ID, [
    makeMrTask(601, square(0), "Too_Hard"), // could-not-complete
    makeMrTask(602, square(1), "Fixed"), // locked
    makeMrTask(603, square(2), "Created"), // normal/oversized/undersized depending on size
  ]);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  assertEqual(await page.$eval('[data-count="could-not-complete"]', (el) => el.textContent), "1", "one area should be tallied as could-not-complete");
  assertEqual(await page.$eval('[data-count="locked"]', (el) => el.textContent), "1", "one area should be tallied as locked");

  await page.click('[data-hide-category="locked"]');
  await page.waitForTimeout(200);

  assertEqual(await page.$eval('[data-count="locked"]', (el) => el.textContent), "1", "hiding a category shouldn't change its own displayed count");
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 3"),
    "the overall stats total should still count every area, hidden or not"
  );

  assertNoPageErrors(page);
  await browser.close();
});
