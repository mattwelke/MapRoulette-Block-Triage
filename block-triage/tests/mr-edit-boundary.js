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

const CHALLENGE_ID = 93001;

function overpassResponseAt(lat, lon) {
  return {
    elements: [
      {
        type: "way",
        id: 1,
        geometry: [
          { lat, lon: lon - 0.01 },
          { lat, lon: lon + 0.01 },
        ],
      },
      {
        type: "way",
        id: 2,
        geometry: [
          { lat: lat - 0.01, lon },
          { lat: lat + 0.01, lon },
        ],
      },
    ],
  };
}

async function findRowByIdx(page, idx) {
  const rows = await page.$$(".feature-row");
  for (const row of rows) {
    const label = await row.$eval(".id", (el) => el.textContent);
    if (label === `#${idx}`) return row;
  }
  return null;
}

runTest("mr-edit-boundary: drag vertices to reshape a linked area, with snapping, queued for MapRoulette sync", async () => {
  const { browser, page } = await launch();
  try {
    await runBody(page);
  } finally {
    await browser.close();
  }
});

async function runBody(page) {
  page.on("dialog", async (dialog) => await dialog.accept());

  const mrState = await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());
  // The mocked intersection always sits exactly at wherever the map is
  // centered at fetch time, so a drag straight to the map's center pixel is
  // an unambiguous, deliberate snap regardless of which entry got panned to.
  await page.route("https://overpass-api.de/api/interpreter**", async (route) => {
    const center = await page.evaluate(() => window.__blockTriageGetMapCenter());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overpassResponseAt(center.lat, center.lng)) });
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Row #3 is Fixed (locked) by fixture design - its popup should not offer
  // Edit boundary at all.
  const lockedRow = await findRowByIdx(page, 3);
  await lockedRow.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-edit-boundary]")) === null, "a locked area's popup should not offer Edit boundary");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Row #0 is unlocked and task-linked by design.
  const row0 = await findRowByIdx(page, 0);
  await row0.click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-edit-boundary]")) !== null, "an unlocked, linked area's popup should offer Edit boundary");

  const areaBefore = await page.evaluate(() => {
    const entries = window.__blockTriageGetEntries();
    let found = null;
    entries.forEach((e) => {
      if (String(e.idx) === "0") found = e;
    });
    return found ? found.area : null;
  });
  assert(areaBefore !== null, "expected row #0's entry to be found before editing");
  await page.click(".leaflet-popup-close-button").catch(() => {});
  await page.waitForTimeout(150);

  // Zoom in (panTo already fit tightly to this tiny fixture area, so the
  // view may already be close to max zoom) before entering edit mode, so
  // the single road-snap fetch it triggers happens at a usable zoom level.
  while ((await page.evaluate(() => window.__blockTriageGetZoom())) < 15) {
    await page.click(".leaflet-control-zoom-in");
    await page.waitForTimeout(400);
  }

  const row0Again = await findRowByIdx(page, 0);
  await row0Again.click();
  await page.waitForTimeout(300);

  await page.click("[data-edit-boundary]");
  await page.waitForTimeout(300);
  assert(
    (await page.$eval("#draw-status-text", (el) => el.textContent)).includes("Drag a point"),
    "draw-status should explain the edit-boundary interaction"
  );

  // Cancel first, to confirm canceling makes no change at all.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (0)",
    "canceling an edit should queue nothing"
  );
  assert(await page.$eval("#undo-btn", (el) => el.disabled), "canceling an edit should not push an undo action");

  // Now actually edit: re-enter (cancel's renderList() rebuilt the list DOM,
  // so re-query the row rather than reuse a stale handle), drag one vertex
  // marker to the map's center - exactly where the mocked intersection is.
  const row0ForEdit = await findRowByIdx(page, 0);
  await row0ForEdit.click();
  await page.waitForTimeout(300);
  await page.click("[data-edit-boundary]");
  await page.waitForTimeout(1000); // let the road-snap fetch resolve

  const marker = await page.$(".edit-vertex-icon");
  assert(!!marker, "expected at least one draggable vertex marker while editing");
  const markerBox = await marker.boundingBox();
  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const snapLatLng = await page.evaluate(() => window.__blockTriageGetMapCenter());

  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (1)",
    "finishing an edit on a linked area should queue it for MapRoulette sync"
  );

  const afterResult = await page.evaluate(
    ({ lat, lon }) => {
      const entries = window.__blockTriageGetEntries();
      let found = null;
      entries.forEach((e) => {
        if (String(e.idx) === "0") found = e;
      });
      if (!found) return { ok: false };
      const ring = found.feature.geometry.coordinates[0];
      const snapPt = turf.point([lon, lat]);
      let minDistKm = Infinity;
      ring.forEach((coord) => {
        const d = turf.distance(turf.point(coord), snapPt, { units: "kilometers" });
        if (d < minDistKm) minDistKm = d;
      });
      return { ok: true, area: found.area, minDistKm, mrTaskId: found.mrTaskId };
    },
    { lat: snapLatLng.lat, lon: snapLatLng.lng }
  );
  assert(afterResult.ok, "expected row #0's entry to still exist after editing");
  assert(afterResult.area !== areaBefore, `expected the area to change after dragging a vertex, still ${afterResult.area}`);
  assert(
    afterResult.minDistKm < 0.002,
    `expected the dragged vertex to have snapped near the mocked intersection, closest ring point was ${afterResult.minDistKm}km away`
  );
  assertEqual(afterResult.mrTaskId, 600001, "the edited entry should keep its original task id until the edit queue is processed");

  // Process the boundary-edit queue: old task deleted, new one created.
  await page.click("#mr-edit-queue-btn");
  await page.waitForTimeout(1500);

  assertEqual(
    JSON.stringify(mrState.deletedTaskIds),
    JSON.stringify(["600001"]),
    `expected the old task deleted, got: ${JSON.stringify(mrState.deletedTaskIds)}`
  );
  assertEqual(mrState.createdTasks.length, 1, "expected exactly 1 new task created");
  assertEqual(
    await page.$eval("#mr-edit-queue-btn", (el) => el.textContent),
    "Process boundary-edit queue (0)",
    "the edit queue should be empty after processing"
  );

  const finalTaskId = await page.evaluate(() => {
    const entries = window.__blockTriageGetEntries();
    let found = null;
    entries.forEach((e) => {
      if (String(e.idx) === "0") found = e;
    });
    return found ? found.mrTaskId : null;
  });
  assert(finalTaskId !== null && finalTaskId !== 600001, `expected a fresh task id after processing, got ${finalTaskId}`);

  assertNoPageErrors(page);
}
