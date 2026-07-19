const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  assertEqual,
  runTest,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 90001;

runTest("maproulette-basic: API key persistence, load, add/remove task labels", async () => {
  const { browser, page } = await launch();
  page.on("dialog", async (dialog) => await dialog.accept());

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(500);

  assertEqual(await page.$eval("#mr-api-key-input", (el) => el.value), "", "API key input should start empty");

  await page.click("#mr-test-btn");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#mr-status", (el) => el.textContent)).length > 0,
    "clicking Test connection with no API key should show a client-side message"
  );

  await page.fill("#mr-api-key-input", "fake-test-key-123");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(100);

  await page.reload();
  await page.waitForTimeout(500);
  assertEqual(
    await page.$eval("#mr-api-key-input", (el) => el.value),
    "fake-test-key-123",
    "API key should persist across a reload via localStorage"
  );

  await page.click("#mr-api-key-clear-btn");
  await page.waitForTimeout(200);
  assertEqual(await page.$eval("#mr-api-key-input", (el) => el.value), "", "Clear should empty the API key input");
  await page.reload();
  await page.waitForTimeout(500);
  assertEqual(
    await page.$eval("#mr-api-key-input", (el) => el.value),
    "",
    "cleared API key should stay empty after reload"
  );

  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key-123");
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 10"), "expected the 10-task fixture to load");

  // Row #0 is unlocked and task-linked by design (see mrChallengeSampleTasks) -
  // its popup should offer "Remove task from challenge".
  const rows = await page.$$(".feature-row");
  await rows[0].click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Remove task from challenge",
    "a loaded, task-linked, unlocked feature should offer Remove"
  );

  // Queue it (no network call happens until "Process delete queue").
  await page.click("[data-mr-action]");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("[data-mr-status]", (el) => el.textContent)).toLowerCase().includes("queued"),
    "clicking Remove should queue it, not delete immediately"
  );
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending removal",
    "button should flip to Cancel pending removal once queued"
  );
  await page.click("[data-mr-action]"); // dequeue again, don't actually leave it queued for the rest of this test
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});

  // Draw a new area from scratch - it should auto-queue for adding and its
  // popup should offer both the queue toggle and an immediate "Add now".
  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const pts = [
    { x: mapBox.x + 300, y: mapBox.y + 250 },
    { x: mapBox.x + 500, y: mapBox.y + 250 },
    { x: mapBox.x + 400, y: mapBox.y + 450 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  const rowsAfterAdd = await page.$$(".feature-row");
  let newAreaRow = null;
  for (const row of rowsAfterAdd) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label.includes("new-")) {
      newAreaRow = row;
      break;
    }
  }
  assert(!!newAreaRow, "expected a freshly-drawn new-N area in the list");
  await newAreaRow.click();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("[data-mr-action]", (el) => el.textContent),
    "Cancel pending add",
    "a freshly-drawn, unlinked area should be auto-queued for adding"
  );
  assert((await page.$("[data-mr-add-now]")) !== null, "an unlinked area's popup should also offer Add now");
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (1)",
    "the sidebar add-queue button should reflect the auto-queued area"
  );

  await page.click("[data-mr-add-now]");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("[data-mr-status]", (el) => el.textContent)).includes("Added as MapRoulette task"),
    "Add now should create a new MapRoulette task and report its id"
  );
  assertEqual(
    await page.$eval("#mr-add-queue-btn", (el) => el.textContent),
    "Process add queue (0)",
    "adding it immediately should also drop it out of the add queue"
  );

  assertNoPageErrors(page);
  await browser.close();
});
