const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  runTest,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 44001;

// A simple "+" crossing: one east-west way and one north-south way, crossing
// exactly at (lat 43.45, lon -79.68) - the map's default center/zoom before
// any challenge is loaded (live.js: L.map(...).setView([43.45, -79.68], 12)),
// so zooming in without panning keeps that point at the container's center.
// The crossing point is listed as an actual shared node in both ways' own
// geometry (a middle point, not just the two endpoints) - snapping reads
// every way's nodes directly rather than computing crossings geometrically,
// matching how OSM itself represents a real at-grade junction.
const INTERSECTION_LAT = 43.45;
const INTERSECTION_LON = -79.68;

function overpassResponse() {
  return {
    elements: [
      {
        type: "way",
        id: 1,
        geometry: [
          { lat: INTERSECTION_LAT, lon: INTERSECTION_LON - 0.005 },
          { lat: INTERSECTION_LAT, lon: INTERSECTION_LON },
          { lat: INTERSECTION_LAT, lon: INTERSECTION_LON + 0.005 },
        ],
      },
      {
        type: "way",
        id: 2,
        geometry: [
          { lat: INTERSECTION_LAT - 0.005, lon: INTERSECTION_LON },
          { lat: INTERSECTION_LAT, lon: INTERSECTION_LON },
          { lat: INTERSECTION_LAT + 0.005, lon: INTERSECTION_LON },
        ],
      },
    ],
  };
}

runTest("road-snap: Add-new-area clicks snap to road/path intersections and carve a small inset", async () => {
  const { browser, page } = await launch();
  try {
    await runBody(page);
  } finally {
    await browser.close();
  }
});

async function runBody(page) {
  page.on("dialog", async (dialog) => await dialog.accept());

  const overpassRequests = [];
  await page.route("https://overpass-api.de/api/interpreter**", async (route) => {
    overpassRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overpassResponse()) });
  });

  // Zero-task load is enough to enable Add new area - this test only cares
  // about the drawing/snapping behavior, not any existing areas.
  await routeMrChallenge(page, CHALLENGE_ID, []);

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");
  assert(!(await page.$eval("#add-area-btn", (el) => el.disabled)), "Add new area should be enabled after loading a challenge");

  // Below the road-snap zoom threshold (15), starting to draw should say so
  // and not attempt any Overpass fetch.
  await page.click("#add-area-btn");
  await page.waitForTimeout(200);
  assert(
    (await page.$eval("#draw-status-text", (el) => el.textContent)).includes("Zoom in further"),
    "starting to draw below the snap zoom threshold should explain that snapping needs a closer zoom"
  );
  assert(overpassRequests.length === 0, "no Overpass request should fire below the zoom threshold");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Zoom in past the threshold (starts at 12, needs >=15) without panning -
  // the map center stays exactly where it started. Each click needs enough
  // time before the next for Leaflet's animated zoom transition to actually
  // register (too tight an interval drops clicks under headless rendering).
  for (let i = 0; i < 4; i++) {
    await page.click(".leaflet-control-zoom-in");
    await page.waitForTimeout(400);
  }
  assert((await page.evaluate(() => window.__blockTriageGetZoom())) >= 15, "expected the zoom-in loop to reach the snap threshold");

  await page.click("#add-area-btn");
  await page.waitForTimeout(1000);
  assert(overpassRequests.length === 1, `expected exactly 1 Overpass request once zoomed in, got ${overpassRequests.length}`);
  assert(overpassRequests[0].includes("highway"), "the Overpass query should filter on highway=*");
  assert(
    (await page.$eval("#draw-status-text", (el) => el.textContent)).includes("Snapping enabled"),
    "draw-status should confirm snapping is enabled once the fetch resolves"
  );

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cx = mapBox.x + mapBox.width / 2;
  const cy = mapBox.y + mapBox.height / 2;

  // First point: right at the map's center, which is also the mocked
  // intersection's location - should snap. The other two points are well
  // away from any intersection and should NOT snap.
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(150);
  await page.mouse.click(cx + 200, cy + 40);
  await page.waitForTimeout(150);
  await page.mouse.click(cx + 100, cy + 220);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  const result = await page.evaluate(
    ({ lat, lon }) => {
      const entries = window.__blockTriageGetEntries();
      let found = null;
      entries.forEach((e) => {
        if (String(e.idx).startsWith("new-")) found = e;
      });
      if (!found) return { ok: false };
      const ring = found.feature.geometry.coordinates[0];
      const intersectionPt = turf.point([lon, lat]);
      let minDistKm = Infinity;
      ring.forEach((coord) => {
        const d = turf.distance(turf.point(coord), intersectionPt, { units: "kilometers" });
        if (d < minDistKm) minDistKm = d;
      });
      return { ok: true, ringLength: ring.length, minDistKm };
    },
    { lat: INTERSECTION_LAT, lon: INTERSECTION_LON }
  );

  assert(result.ok, "expected a freshly-drawn area to exist after finishing the draw");
  // An un-notched triangle's ring is 4 coordinates (3 points + closing
  // repeat) - carving a circular notch out of one corner replaces that
  // vertex with several arc points instead, so a materially longer ring is
  // good evidence the notch was actually applied.
  assert(
    result.ringLength > 6,
    `expected the snapped corner's buffer-difference to add ring vertices (a carved notch), got ring length ${result.ringLength}`
  );
  assert(
    result.minDistKm > 0.0002,
    `expected no ring vertex to sit exactly on the intersection (the notch should keep every vertex at least a little away from it), closest was ${result.minDistKm}km`
  );
  assert(
    result.minDistKm < 0.002,
    `expected the closest ring vertex to stay near the ~0.5m inset radius, not far off from it, got ${result.minDistKm}km`
  );

  assertNoPageErrors(page);
}

// A single way with an L-shaped bend (no other way, so nothing for
// turf.lineIntersect to find) - the bend point itself should still be
// offered as a snap point (a "shape point" / direction-change node).
const BEND_LAT = 43.45;
const BEND_LON = -79.68;

function overpassResponseWithBend() {
  return {
    elements: [
      {
        type: "way",
        id: 3,
        geometry: [
          { lat: BEND_LAT, lon: BEND_LON - 0.005 },
          { lat: BEND_LAT, lon: BEND_LON }, // the bend
          { lat: BEND_LAT + 0.005, lon: BEND_LON },
        ],
      },
    ],
  };
}

runTest("road-snap: also snaps to a road's own bend points, not just crossings between roads", async () => {
  const { browser, page } = await launch();
  try {
    await runBendBody(page);
  } finally {
    await browser.close();
  }
});

async function runBendBody(page) {
  page.on("dialog", async (dialog) => await dialog.accept());

  await page.route("https://overpass-api.de/api/interpreter**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overpassResponseWithBend()) });
  });

  const CHALLENGE_ID_2 = 44002;
  await routeMrChallenge(page, CHALLENGE_ID_2, []);

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID_2, "fake-test-key");

  for (let i = 0; i < 4; i++) {
    await page.click(".leaflet-control-zoom-in");
    await page.waitForTimeout(400);
  }
  assert((await page.evaluate(() => window.__blockTriageGetZoom())) >= 15, "expected the zoom-in loop to reach the snap threshold");

  await page.click("#add-area-btn");
  await page.waitForTimeout(1000);
  assert(
    (await page.$eval("#draw-status-text", (el) => el.textContent)).includes("Snapping enabled"),
    "draw-status should confirm snapping is enabled once the fetch resolves"
  );

  const mapBox = await page.$eval("#map", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cx = mapBox.x + mapBox.width / 2;
  const cy = mapBox.y + mapBox.height / 2;

  await page.mouse.click(cx, cy); // right at the bend
  await page.waitForTimeout(150);
  await page.mouse.click(cx + 200, cy + 40);
  await page.waitForTimeout(150);
  await page.mouse.click(cx + 100, cy + 220);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  const result = await page.evaluate(
    ({ lat, lon }) => {
      const entries = window.__blockTriageGetEntries();
      let found = null;
      entries.forEach((e) => {
        if (String(e.idx).startsWith("new-")) found = e;
      });
      if (!found) return { ok: false };
      const ring = found.feature.geometry.coordinates[0];
      const bendPt = turf.point([lon, lat]);
      let minDistKm = Infinity;
      ring.forEach((coord) => {
        const d = turf.distance(turf.point(coord), bendPt, { units: "kilometers" });
        if (d < minDistKm) minDistKm = d;
      });
      return { ok: true, ringLength: ring.length, minDistKm };
    },
    { lat: BEND_LAT, lon: BEND_LON }
  );

  assert(result.ok, "expected a freshly-drawn area to exist after finishing the draw");
  assert(
    result.ringLength > 6,
    `expected the snapped corner's buffer-difference to add ring vertices (a carved notch), got ring length ${result.ringLength}`
  );
  assert(
    result.minDistKm > 0.0002 && result.minDistKm < 0.002,
    `expected the closest ring vertex to sit near (but not exactly on) the bend point, got ${result.minDistKm}km`
  );

  assertNoPageErrors(page);
}
