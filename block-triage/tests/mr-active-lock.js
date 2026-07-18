const { launch, assertNoPageErrors, liveUrl, assert, assertEqual, runTest } = require("./support");

function makeTask(id, status, lng, lat) {
  return {
    id,
    name: `task-${id}`,
    created: 0,
    modified: 0,
    parent: 66001,
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
                [lng + 0.0006, lat],
                [lng + 0.0006, lat + 0.0006],
                [lng, lat + 0.0006],
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

runTest("mr-active-lock: tasks currently checked out on MapRoulette are locked, by anyone including the API key's own user", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  const CHALLENGE_ID = 66001;
  const MY_USER_ID = 555; // the account behind the configured API key
  const OTHER_USER_ID = 42;

  // Task order == sidebar row order (all same size, stable sort): idx 0..4.
  //   #0 900001 - unlocked throughout
  //   #1 900002 - locked by someone else, throughout
  //   #2 900003 - locked by the SAME account as the API key - this should still
  //               show as active-lock. There's deliberately no "is it me"
  //               carve-out: any lockedBy value counts, full stop.
  //   #3 900004 - unlocked at load, becomes locked-by-other right before a split attempt
  //   #4 900005 - unlocked throughout - used for the "still deletes fine" queue check
  const tasks = [
    makeTask(900001, 0, -79.7, 43.45),
    makeTask(900002, 0, -79.69, 43.45),
    makeTask(900003, 0, -79.68, 43.45),
    makeTask(900004, 0, -79.67, 43.45),
    makeTask(900005, 0, -79.66, 43.45),
  ];

  let lockedByTaskId = { 900002: OTHER_USER_ID, 900003: MY_USER_ID };

  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/taskMarkers`, async (route) => {
    const markers = tasks.map((t) => ({
      id: t.id,
      location: { type: "Point", coordinates: [0, 0] },
      status: t.status,
      priority: 0,
      lockedBy: lockedByTaskId[t.id] != null ? lockedByTaskId[t.id] : null,
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ markers, overlaps: [] }) });
  });
  await page.route(`https://maproulette.org/api/v2/challenge/${CHALLENGE_ID}/tasks**`, async (route) => {
    const url = new URL(route.request().url());
    const pageNum = Number(url.searchParams.get("page"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pageNum === 0 ? tasks : []) });
  });
  const deletedTaskIds = [];
  await page.route("https://maproulette.org/api/v2/task/**", async (route) => {
    if (route.request().method() === "DELETE") {
      const m = route.request().url().match(/\/task\/(\d+)/);
      deletedTaskIds.push(m ? Number(m[1]) : null);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "OK" }) });
    } else {
      await route.continue();
    }
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.fill("#mr-challenge-id-input", String(CHALLENGE_ID));
  await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(200);

  await page.click("#mr-load-challenge-btn");
  await page.waitForTimeout(1500); // load-challenge's kickMrLockPoll fires an immediate lock refresh too

  async function rowByIdx(n) {
    const rows = await page.$$(".feature-row");
    for (const row of rows) {
      const label = await row.$eval(".id", (el) => el.textContent);
      if (label === `#${n}`) return row;
    }
    return null;
  }

  const idx0Class = await (await rowByIdx(0)).$eval(".status-dot", (el) => el.className);
  const idx1Class = await (await rowByIdx(1)).$eval(".status-dot", (el) => el.className);
  const idx2Class = await (await rowByIdx(2)).$eval(".status-dot", (el) => el.className);
  assert(!idx0Class.includes("active-lock"), "unlocked task should not show active-lock");
  assert(idx1Class.includes("active-lock"), "task locked by someone else should show active-lock");
  assert(idx2Class.includes("active-lock"), "task locked by the API key's own user should ALSO show active-lock");

  await (await rowByIdx(1)).click();
  await page.waitForTimeout(300);
  const popupHtml = await page.$eval(".leaflet-popup-content", (el) => el.innerHTML);
  assert(popupHtml.includes("checked out on MapRoulette"), "popup should explain the task is checked out");
  assert(!popupHtml.includes("data-split"), "locked popup should omit Split");
  assert(!popupHtml.includes("data-mr-action"), "locked popup should omit mr-action");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);

  // Combine-select should refuse an actively-locked entry.
  const dialogsBeforeCombine = dialogs.length;
  await page.click("#combine-area-btn");
  await page.waitForTimeout(200);
  await (await rowByIdx(1)).click();
  await page.waitForTimeout(200);
  assert(dialogs.length > dialogsBeforeCombine, "combine-selecting an active-lock row should alert");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Quick queue-delete mode should refuse an actively-locked entry (map click).
  await (await rowByIdx(1)).click();
  await page.waitForTimeout(300);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);
  await page.click("#mr-quick-queue-checkbox");
  await page.waitForTimeout(200);
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const dialogsBeforeQuickQueue = dialogs.length;
  await page.mouse.click(mapBox.x, mapBox.y);
  await page.waitForTimeout(300);
  assert(dialogs.length > dialogsBeforeQuickQueue, "quick-queue map click on an active-lock area should alert, not queue");
  assertEqual(await page.$eval("#mr-queue-btn", (el) => el.textContent), "Process delete queue (0)", "nothing should be queued");
  await page.click("#mr-quick-queue-checkbox"); // back off
  await page.waitForTimeout(200);

  // Split just-in-time recheck: #3 looks unlocked now, but becomes locked by
  // someone else right before the user commits to splitting it.
  await (await rowByIdx(3)).click();
  await page.waitForTimeout(300);
  lockedByTaskId[900004] = OTHER_USER_ID; // simulate the lock appearing server-side, right now
  const dialogsBeforeSplit = dialogs.length;
  await page.click("[data-split]");
  await page.waitForTimeout(800); // the recheck does a network round trip
  assert(dialogs.length > dialogsBeforeSplit, "the split recheck should catch the newly-appeared lock and alert");
  assert(await page.$eval("#draw-status", (el) => el.hidden), "drawing mode should NOT start after a blocked split attempt");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);

  // Delete-queue just-in-time recheck: #3 (now locked) should no longer offer
  // Remove at all; queue #4 (900005, stays unlocked) and #0 (900001, gets
  // locked while sitting in the queue) to confirm the recheck skips it.
  await (await rowByIdx(3)).click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-mr-action]")) === null, "#3's popup should no longer offer Remove now that it's locked");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);

  await (await rowByIdx(4)).click();
  await page.waitForTimeout(300);
  await page.click("[data-mr-action]"); // queue 900005
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);

  await (await rowByIdx(0)).click();
  await page.waitForTimeout(300);
  await page.click("[data-mr-action]"); // queue 900001
  await page.waitForTimeout(200);
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(200);

  assertEqual(await page.$eval("#mr-queue-btn", (el) => el.textContent), "Process delete queue (2)", "expected 2 items queued");
  lockedByTaskId[900001] = OTHER_USER_ID; // lock appears on 900001 while it sits in the queue

  await page.click("#mr-queue-btn");
  await page.waitForTimeout(4000);

  const queueStatus = await page.$eval("#mr-queue-status", (el) => el.textContent);
  assert(queueStatus.includes("skipped") || queueStatus.toLowerCase().includes("locked"), `expected the skip to be reported, got: ${queueStatus}`);
  assert((await page.$eval("#stats", (el) => el.textContent)).includes("Total: 4"), "only 900005 should actually be deleted (5 - 1)");
  assertEqual(JSON.stringify(deletedTaskIds), JSON.stringify([900005]), `expected only 900005 to actually be deleted, got: ${JSON.stringify(deletedTaskIds)}`);

  assertNoPageErrors(page);
  await browser.close();
});
