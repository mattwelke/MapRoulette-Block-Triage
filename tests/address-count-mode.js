const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  makeMrTask,
  routeMrChallenge,
  routeAddressPoints,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90002;

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

// A short diagonal line of n points, close enough together to all land
// inside a 0.01°-square starting at (lng0, lat0).
function pointsIn(lng0, lat0, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([lng0 + 0.0001 * i, lat0 + 0.0001 * i]);
  return pts;
}

async function findRowByIdx(page, idx) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label === `#${idx}`) return row;
  }
  return null;
}

runTest("address-count-mode: toggling to address-count mode colors by injected point counts, not area", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  // Three widely-separated squares, each much bigger than the default 5000 m²
  // area target (so they'd all show oversized under area mode) - the point
  // is to prove the coloring instead tracks address count once that mode is
  // selected.
  const tasks = [
    makeMrTask(900001, square(-79.7, 43.4, 0.01), "Created"), // 20 points -> oversized
    makeMrTask(900002, square(-79.6, 43.4, 0.01), "Created"), // 15 points -> normal
    makeMrTask(900003, square(-79.5, 43.4, 0.01), "Created"), // 8 points -> undersized
  ];
  const points = [
    ...pointsIn(-79.699, 43.401, 20),
    ...pointsIn(-79.599, 43.401, 15),
    ...pointsIn(-79.499, 43.401, 8),
    [-79.8, 43.4], // decoy, outside every square - must not be counted anywhere
  ];

  await routeAddressPoints(page, points);
  await routeMrChallenge(page, CHALLENGE_ID, tasks);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Address-count thresholds should start hidden (area is the default mode).
  assert(await page.$eval("#address-count-thresholds", (el) => el.hidden), "address-count-thresholds should start hidden");

  await page.click('input[name="coloring-mode"][value="addressCount"]');
  await page.waitForTimeout(300);

  assert(!(await page.$eval("#address-count-thresholds", (el) => el.hidden)), "address-count-thresholds should show once selected");
  assert(await page.$eval("#area-thresholds", (el) => el.hidden), "area-thresholds should hide once addressCount is selected");

  // Defaults: target 15, band 5 -> oversized >= 20, undersized <= 10.
  const rowA = await findRowByIdx(page, 0);
  const rowB = await findRowByIdx(page, 1);
  const rowC = await findRowByIdx(page, 2);
  assertEqual(await rowA.$eval(".status-dot", (el) => el.className), "status-dot oversized", "20 addresses should be oversized (>= target+band)");
  assertEqual(await rowB.$eval(".status-dot", (el) => el.className), "status-dot normal", "15 addresses should be normal (within band of target)");
  assertEqual(await rowC.$eval(".status-dot", (el) => el.className), "status-dot undersized", "8 addresses should be undersized (<= target-band)");

  const stats = await page.$eval("#stats", (el) => el.textContent);
  assert(stats.includes("Oversized (needs split): 1"), `expected 1 oversized, got: ${stats}`);
  assert(stats.includes("Undersized (needs combine): 1"), `expected 1 undersized, got: ${stats}`);
  assert(stats.includes("Normal: 1"), `expected 1 normal, got: ${stats}`);

  // Lowering the target re-categorizes live, same as target-area-limit does
  // in area mode.
  await page.fill("#target-address-count", "10");
  await page.waitForTimeout(300);

  assertEqual(
    await (await findRowByIdx(page, 0)).$eval(".status-dot", (el) => el.className),
    "status-dot oversized",
    "20 addresses should still be oversized against a target of 10 (>= 10+5)"
  );
  assertEqual(
    await (await findRowByIdx(page, 1)).$eval(".status-dot", (el) => el.className),
    "status-dot oversized",
    "15 addresses should become oversized once the target drops to 10 (>= 10+5)"
  );
  assertEqual(
    await (await findRowByIdx(page, 2)).$eval(".status-dot", (el) => el.className),
    "status-dot normal",
    "8 addresses should become normal once the target drops to 10 (> 10-5)"
  );

  // Switching back to area mode should restore area-based coloring - all
  // three squares are well over the (unchanged) default 5000 m² area target.
  await page.click('input[name="coloring-mode"][value="area"]');
  await page.waitForTimeout(300);
  assertEqual(
    await (await findRowByIdx(page, 2)).$eval(".status-dot", (el) => el.className),
    "status-dot oversized",
    "square C should be oversized by area once back in area mode, despite being address-count-normal"
  );

  assertNoPageErrors(page);
  await browser.close();
});

runTest("address-count-mode: switching modes keeps each mode's own target/band settings independent", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  const tasks = [makeMrTask(900010, square(-79.7, 43.4, 0.01), "Created")];
  await routeAddressPoints(page, pointsIn(-79.699, 43.401, 12));
  await routeMrChallenge(page, CHALLENGE_ID, tasks);

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await page.fill("#target-area-limit", "12345");
  await page.waitForTimeout(200);

  await page.click('input[name="coloring-mode"][value="addressCount"]');
  await page.waitForTimeout(200);
  await page.fill("#target-address-count", "12");
  await page.fill("#address-count-band", "1");
  await page.waitForTimeout(200);

  await page.click('input[name="coloring-mode"][value="area"]');
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("#target-area-limit", (el) => el.value),
    "12345",
    "the area target should be unaffected by having visited address-count mode"
  );

  assertNoPageErrors(page);
  await browser.close();
});
