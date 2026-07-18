const { launch, assertNoPageErrors, mobileUrl, assert, assertEqual, runTest } = require("./support");

function makeTask(id, side) {
  const lng = -79.7 + id * 0.01;
  const lat = 43.45;
  return {
    id,
    name: `task-${id}`,
    created: 0,
    modified: 0,
    parent: 82000,
    geometries: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [lng, lat],
                [lng + side, lat],
                [lng + side, lat + side],
                [lng, lat + side],
                [lng, lat],
              ],
            ],
          },
        },
      ],
    },
    review: {},
    priority: 0,
    errorTags: "",
    skipCount: 0,
    archived: false,
    status: 0,
  };
}

runTest("mobile-delete-failure: a failed delete stays on the same task and re-enables Delete", async () => {
  const { browser, page } = await launch();

  const CHALLENGE_ID = 82000;
  const tasks = [makeTask(800001, 0.0003), makeTask(800002, 0.0006)];

  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const pageNum = Number(url.searchParams.get("page"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageNum === 0 ? tasks : []) });
  });
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "Error" }) });
    } else {
      await route.continue();
    }
  });

  await page.goto(mobileUrl());
  await page.waitForTimeout(300);
  await page.fill("#api-key-input", "fake-test-key");
  await page.fill("#challenge-id-input", String(CHALLENGE_ID));
  await page.click("#load-btn");
  await page.waitForSelector("#triage-screen:not([hidden])", { timeout: 5000 });
  assertEqual(await page.$eval("#progress", (el) => el.textContent), "1 of 2", "expected both tasks loaded");

  await page.waitForTimeout(1100);
  await page.click("#delete-btn");
  await page.waitForTimeout(500);

  assert(
    (await page.$eval("#action-status", (el) => el.textContent)).toLowerCase().includes("failed"),
    "a failed delete should show an inline error"
  );
  assertEqual(await page.$eval("#progress", (el) => el.textContent), "1 of 2", "the failed item should not be removed from the queue");
  assertEqual(await page.$eval("#task-id", (el) => el.textContent), "Task 800001", "should still be showing the same task");
  assert(!(await page.$eval("#delete-btn", (el) => el.disabled)), "Delete should re-enable immediately after a failed attempt");
  assert(await page.$eval("#undo-banner", (el) => el.hidden), "no undo banner should appear for a delete that never succeeded");

  assertNoPageErrors(page);
  await browser.close();
});
