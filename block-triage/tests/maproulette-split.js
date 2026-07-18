const { launch, assertNoPageErrors, appUrl, fixturePath, assert, runTest } = require("./support");

runTest("maproulette-split: local split succeeds even when the MapRoulette sync fails", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  // Deterministically fail every MapRoulette task request, instead of relying
  // on the real host being unreachable - this is what the split-sync failure
  // path (see syncSplitToMapRoulette in app.js) needs to exercise.
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "Error" }) });
  });

  await page.goto(appUrl());
  await page.waitForTimeout(500);
  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

  // Row #9 is the largest, unlocked, task-linked feature by design.
  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);
  assert(!!(await page.$("[data-mr-action]")), "the feature being split should still be task-linked before splitting");
  await page.click("[data-split]");
  await page.waitForTimeout(300);

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.click(mapBox.x + 20, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.click(mapBox.x + mapBox.width - 20, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);

  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 11"), "the local split should succeed regardless of remote sync outcome");

  // Give the async MapRoulette sync (delete + 2 creates) time to run and fail.
  await page.waitForTimeout(2000);
  assert(
    dialogs.some((d) => d.toLowerCase().includes("failed")),
    `expected an alert about the failed MapRoulette sync, got dialogs: ${JSON.stringify(dialogs)}`
  );
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 11"), "the failed sync should not undo the local split");

  assertNoPageErrors(page);
  await browser.close();
});
