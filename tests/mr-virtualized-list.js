const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90201;
const TASK_COUNT = 300;

function square(lng, lat, size) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng, lat],
        [lng + size, lat],
        [lng + size, lat + size],
        [lng, lat + size],
        [lng, lat],
      ],
    ],
  };
}

// Small squares laid out on a grid, far enough apart that none touch (so
// nothing accidentally looks combinable) and each with a distinct area (so
// sorting by area gives a stable, predictable order for this test).
function manyTasks(count) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const col = i % 20;
    const row = Math.floor(i / 20);
    const size = 0.0005 + i * 0.000001; // strictly increasing area
    tasks.push(makeMrTask(900001 + i, square(-79.9 + col * 0.01, 43.6 + row * 0.01, size), "Created"));
  }
  return tasks;
}

runTest("mr-virtualized-list: only rows scrolled into view are in the DOM, and scrolling reveals the rest", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await routeMrChallenge(page, CHALLENGE_ID, manyTasks(TASK_COUNT));

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  assert((await page.$eval("#stats", (el) => el.textContent)).includes(`Total: ${TASK_COUNT}`), `expected all ${TASK_COUNT} tasks to load`);

  const rowCountAtTop = await page.$$eval(".feature-row", (rows) => rows.length);
  assert(
    rowCountAtTop > 0 && rowCountAtTop < TASK_COUNT / 2,
    `expected far fewer than ${TASK_COUNT} rows actually in the DOM at once, got ${rowCountAtTop}`
  );

  const sizerHeight = await page.$eval("#feature-list-sizer", (el) => el.getBoundingClientRect().height);
  const rowHeight = await page.$eval(".feature-row", (el) => el.getBoundingClientRect().height);
  const expectedSizerHeight = TASK_COUNT * rowHeight;
  assert(
    Math.abs(sizerHeight - expectedSizerHeight) < 1,
    `expected the sizer's height (${sizerHeight}) to reflect all ${TASK_COUNT} rows at ${rowHeight}px each (~${expectedSizerHeight})`
  );

  // The smallest area (task index 0) sorts first - it should be visible
  // without any scrolling.
  const topIds = await page.$$eval(".feature-row .id", (els) => els.map((e) => e.textContent));
  assert(topIds.includes("#0"), `expected row #0 (smallest area) to be rendered at the top unscrolled, got: ${JSON.stringify(topIds)}`);

  // Scroll the list to the very bottom - the largest area (task index
  // TASK_COUNT - 1) should now be rendered, and the previously-visible top
  // rows should have been dropped from the DOM (not just accumulated).
  await page.$eval("#feature-list", (el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(200);

  const rowCountAtBottom = await page.$$eval(".feature-row", (rows) => rows.length);
  assert(
    rowCountAtBottom > 0 && rowCountAtBottom < TASK_COUNT / 2,
    `expected the rendered row count to stay bounded after scrolling, got ${rowCountAtBottom}`
  );

  const bottomIds = await page.$$eval(".feature-row .id", (els) => els.map((e) => e.textContent));
  assert(
    bottomIds.includes(`#${TASK_COUNT - 1}`),
    `expected the largest area's row to be rendered after scrolling to the bottom, got: ${JSON.stringify(bottomIds)}`
  );
  assert(!bottomIds.includes("#0"), "expected row #0 to have been dropped from the DOM after scrolling away from it");

  // Clicking a row that only exists because we scrolled to it should still
  // work normally (select it, open its popup) - virtualization shouldn't
  // change any behavior, just how much is in the DOM at once.
  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);
  assert(!!(await page.$(".leaflet-popup-content")), "clicking a virtualized-in row should open its popup like any other row");

  assertNoPageErrors(page);
  await browser.close();
});
