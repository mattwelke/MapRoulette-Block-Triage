const { launch, assertNoPageErrors, mobileUrl, assert, assertEqual, runTest } = require("./support");

runTest("mobile-auto-load: revisiting with saved credentials skips straight to the queue", async () => {
  const { browser, page } = await launch();

  const CHALLENGE_ID = 83000;
  await page.addInitScript(
    ({ challengeId }) => {
      localStorage.setItem("block-triage:mrApiKey", "fake-test-key");
      localStorage.setItem("block-triage:mrChallengeId", String(challengeId));
    },
    { challengeId: CHALLENGE_ID }
  );

  const task = {
    id: 830001,
    name: "task-830001",
    created: 0,
    modified: 0,
    parent: CHALLENGE_ID,
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
                [-79.7, 43.45],
                [-79.6996, 43.45],
                [-79.6996, 43.4504],
                [-79.7, 43.4504],
                [-79.7, 43.45],
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
  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const pageNum = Number(url.searchParams.get("page"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageNum === 0 ? [task] : []) });
  });

  await page.goto(mobileUrl());
  await page.waitForSelector("#triage-screen:not([hidden])", { timeout: 5000 });

  assert(await page.$eval("#setup-screen", (el) => el.hidden), "setup screen should be skipped when credentials are already saved");
  assertEqual(await page.$eval("#task-id", (el) => el.textContent), "Task 830001", "should load straight into the saved challenge's queue");
  assertEqual(
    await page.$eval("#api-key-input", (el) => el.value),
    "fake-test-key",
    "the input should still reflect the saved key even though setup was skipped"
  );

  assertNoPageErrors(page);
  await browser.close();
});
