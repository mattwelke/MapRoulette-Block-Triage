const {
  launch,
  assertNoPageErrors,
  localUrl,
  liveUrl,
  fixturePath,
  assert,
  assertEqual,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const OVERLAP_COLOR = "#e91e63";

runTest("overlap-highlight: local file triage highlights overlapping areas and clears them on reload", async () => {
  const { browser, page } = await launch();

  await page.goto(localUrl());
  await page.waitForTimeout(400);
  await page.setInputFiles("#file-input", fixturePath("overlapping-squares.geojson"));
  await page.waitForTimeout(1000);

  assertEqual(
    await page.$eval("#overlap-status", (el) => el.textContent),
    "",
    "the overlap status should be empty until the toggle is turned on"
  );
  assert((await page.$(`svg path[stroke="${OVERLAP_COLOR}"]`)) === null, "no overlap highlight should exist until toggled on");

  await page.click("#highlight-overlaps-checkbox");
  await page.waitForTimeout(300);

  assertEqual(
    await page.$eval("#overlap-status", (el) => el.textContent),
    "1 overlapping area found.",
    "expected exactly one overlapping pair among the three squares (two overlap, one is isolated)"
  );
  const overlapPath = await page.$(`svg path[stroke="${OVERLAP_COLOR}"]`);
  assert(overlapPath !== null, "expected an SVG path drawn in the overlap color");

  // Toggling off removes the highlight and clears the status.
  await page.click("#highlight-overlaps-checkbox");
  await page.waitForTimeout(200);
  assertEqual(await page.$eval("#overlap-status", (el) => el.textContent), "", "status should clear when toggled off");
  assert((await page.$(`svg path[stroke="${OVERLAP_COLOR}"]`)) === null, "the highlight should be removed when toggled off");

  // Turn it back on, then load a fresh file - both the checkbox and the
  // highlight should reset rather than carrying stale results over.
  await page.click("#highlight-overlaps-checkbox");
  await page.waitForTimeout(300);
  await page.setInputFiles("#file-input", fixturePath("square.geojson"));
  await page.waitForTimeout(1000);
  assert(!(await page.$eval("#highlight-overlaps-checkbox", (el) => el.checked)), "loading a new file should reset the toggle");
  assertEqual(await page.$eval("#overlap-status", (el) => el.textContent), "", "loading a new file should clear the overlap status");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("overlap-highlight: live MapRoulette editing also supports it", async () => {
  const { browser, page } = await launch();

  const fs = require("fs");
  const fc = JSON.parse(fs.readFileSync(fixturePath("overlapping-squares.geojson"), "utf8"));
  const tasks = fc.features.map((f, i) => makeMrTask(600001 + i, f.geometry));

  const CHALLENGE_ID = 90099;
  await routeMrChallenge(page, CHALLENGE_ID, tasks);
  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  await page.click("#highlight-overlaps-checkbox");
  await page.waitForTimeout(300);

  assertEqual(
    await page.$eval("#overlap-status", (el) => el.textContent),
    "1 overlapping area found.",
    "expected exactly one overlapping pair among the three loaded task areas"
  );
  assert((await page.$(`svg path[stroke="${OVERLAP_COLOR}"]`)) !== null, "expected an SVG path drawn in the overlap color");

  assertNoPageErrors(page);
  await browser.close();
});
