const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  runTest,
  makeMrTask,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 92001;

runTest("mr-combine-reject: combining genuinely far-apart areas is rejected, not bridged", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

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

  const tasks = [
    makeMrTask(700001, square(-79.7, 43.45, 0.0005), "Created"),
    makeMrTask(700002, square(-79.6, 43.5, 0.0005), "Created"), // far away from the first - shouldn't bridge
  ];
  await routeMrChallenge(page, CHALLENGE_ID, tasks);

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"), "expected both far-apart tasks to load");

  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  const rows = await page.$$(".feature-row");
  assert(rows.length === 2, "expected exactly 2 rows to select for combining");
  await rows[0].click();
  await page.waitForTimeout(150);
  const rowsAgain = await page.$$(".feature-row"); // re-query, renderList() rebuilds the DOM
  await rowsAgain[1].click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  assert(
    dialogs.some((d) => d.includes("MultiPolygon")),
    `expected a MultiPolygon-rejection alert, got dialogs: ${JSON.stringify(dialogs)}`
  );
  assert(
    (await page.$eval("#stats", (el) => el.textContent)).includes("Total: 2"),
    "rejecting the combine should leave both areas untouched"
  );

  assertNoPageErrors(page);
  await browser.close();
});
