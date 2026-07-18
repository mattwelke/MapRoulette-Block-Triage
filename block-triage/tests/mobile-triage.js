const { launch, assertNoPageErrors, mobileUrl, assert, assertEqual, assertRenderedVisibility, runTest } = require("./support");

function makeTask(id, status, side) {
  // Squares of increasing size, spread out along longitude so they never overlap.
  const lng = -79.7 + id * 0.01;
  const lat = 43.45;
  return {
    id,
    name: `task-${id}`,
    created: 0,
    modified: 0,
    parent: 81000,
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
    status,
  };
}

runTest("mobile-triage: smallest-first queue, delete-delay guard, undo, skip, done screen", async () => {
  const { browser, page } = await launch();

  const CHALLENGE_ID = 81000;
  // Deliberately out of area order and with a locked one mixed in, to prove
  // both the sort and the locked-task filtering.
  const tasks = [
    makeTask(700003, 0, 0.0006),
    makeTask(700006, 1, 0.0001), // Fixed - smallest by far, must NOT appear at all
    makeTask(700001, 0, 0.0002),
    makeTask(700005, 5, 0.0009), // Already_Fixed - must NOT appear at all
    makeTask(700002, 0, 0.0004),
    makeTask(700004, 0, 0.0008),
  ];

  const deletedTaskIds = [];
  const createdFeatures = [];
  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const pageNum = Number(url.searchParams.get("page"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageNum === 0 ? tasks : []) });
  });
  await page.route("https://maproulette.org/api/v2/task", async (route) => {
    const body = JSON.parse(route.request().postData());
    createdFeatures.push(body.geometries.features[0].geometry);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 999001, status: "OK" }) });
  });
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    if (route.request().method() === "DELETE") {
      const m = route.request().url().match(/\/task\/(\d+)/);
      deletedTaskIds.push(m ? Number(m[1]) : null);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "OK" }) });
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

  assert(await page.$eval("#setup-screen", (el) => el.hidden), "setup screen should hide once loaded");
  assert(!(await page.$eval("#triage-screen", (el) => el.hidden)), "triage screen should show once loaded");
  await assertRenderedVisibility(page, "#setup-screen", false, "setup screen should actually be invisible, not just the hidden property set");
  await assertRenderedVisibility(page, "#triage-screen", true, "triage screen should actually be rendered, not just the hidden property clear");
  await assertRenderedVisibility(page, "#done-screen", false, "done screen should not be rendered while the queue still has items");
  assertEqual(await page.$eval("#progress", (el) => el.textContent), "1 of 4", "expected 4 unlocked tasks out of 6 total");
  assertEqual(await page.$eval("#task-id", (el) => el.textContent), "Task 700001", "smallest unlocked task (700001) should show first");

  assert(await page.$eval("#delete-btn", (el) => el.disabled), "Delete should start disabled right after showing a task");
  await page.waitForTimeout(1100);
  assert(!(await page.$eval("#delete-btn", (el) => el.disabled)), "Delete should enable itself after the 1s guard");

  // Skip past 700001 without deleting it.
  await page.click("#next-btn");
  await page.waitForTimeout(100);
  assertEqual(await page.$eval("#progress", (el) => el.textContent), "2 of 4", "Next should just advance, no deletion");
  assertEqual(await page.$eval("#task-id", (el) => el.textContent), "Task 700002", "expected the next-smallest task after skipping");
  assert(await page.$eval("#delete-btn", (el) => el.disabled), "Delete should re-disable itself for the newly-shown task");
  assertEqual(deletedTaskIds.length, 0, "nothing should have been deleted yet");

  await page.waitForTimeout(1100);
  await page.click("#delete-btn");
  await page.waitForTimeout(500);

  assertEqual(JSON.stringify(deletedTaskIds), JSON.stringify([700002]), "expected task 700002 to be deleted");
  assertEqual(await page.$eval("#progress", (el) => el.textContent), "2 of 3", "queue should shrink and advance past the deleted item");
  assertEqual(await page.$eval("#task-id", (el) => el.textContent), "Task 700003", "expected 700003 to be showing now");
  assert(!(await page.$eval("#undo-banner", (el) => el.hidden)), "undo banner should appear after a delete");
  assert(
    (await page.$eval("#undo-text", (el) => el.textContent)).includes("700002"),
    "undo banner should mention the deleted task's id"
  );

  await page.click("#undo-btn");
  await page.waitForTimeout(300);
  assertEqual(createdFeatures.length, 1, "undo should have recreated exactly one task");
  assert(
    (await page.$eval("#undo-text", (el) => el.textContent)).includes("999001"),
    "banner should confirm the new task id after undo"
  );
  assert(!(await page.$eval("#undo-banner", (el) => el.hidden)), "banner should stay visible showing the recreation result");

  await page.click("#undo-dismiss-btn");
  await page.waitForTimeout(100);
  assert(await page.$eval("#undo-banner", (el) => el.hidden), "dismissing should hide the banner");

  // Walk through the remaining tasks (700003, 700004) without deleting - done screen at the end.
  await page.click("#next-btn");
  await page.waitForTimeout(100);
  assertEqual(await page.$eval("#task-id", (el) => el.textContent), "Task 700004", "expected the last remaining task");
  await page.click("#next-btn");
  await page.waitForTimeout(100);
  assert(await page.$eval("#triage-screen", (el) => el.hidden), "triage screen should hide once the queue is exhausted");
  assert(!(await page.$eval("#done-screen", (el) => el.hidden)), "done screen should show once the queue is exhausted");
  await assertRenderedVisibility(page, "#triage-screen", false, "triage screen should actually be invisible once the queue is exhausted");
  await assertRenderedVisibility(page, "#done-screen", true, "done screen should actually be rendered once the queue is exhausted");

  assertNoPageErrors(page);
  await browser.close();
});
