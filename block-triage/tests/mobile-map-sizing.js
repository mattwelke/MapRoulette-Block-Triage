const { launch, assertNoPageErrors, mobileUrl, assert, runTest } = require("./support");

// Regression test for a real bug: the Leaflet map is created while
// #triage-screen is still hidden (display:none), so Leaflet measures a
// zero-size container and caches it - showing only a sliver of tiles in one
// corner once the screen becomes visible, until something calls
// invalidateSize(). See the map.invalidateSize() calls in showCurrentTask().
runTest("mobile-map-sizing: the map's internal size matches its actual rendered container", async () => {
  const { browser, page } = await launch();

  const CHALLENGE_ID = 84000;
  const task = {
    id: 840001,
    name: "task-840001",
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
  await page.waitForTimeout(300);
  await page.fill("#api-key-input", "fake-test-key");
  await page.fill("#challenge-id-input", String(CHALLENGE_ID));
  await page.click("#load-btn");
  await page.waitForSelector("#triage-screen:not([hidden])", { timeout: 5000 });
  await page.waitForTimeout(200); // let the rAF follow-up run too

  const containerRect = await page.$eval("#map", (el) => el.getBoundingClientRect());
  const leafletSize = await page.evaluate(() => window.__blockTriageMobileMap.getSize());

  assert(containerRect.width > 100 && containerRect.height > 100, `sanity: container should have real size, got ${JSON.stringify(containerRect)}`);
  assert(
    Math.abs(leafletSize.x - containerRect.width) <= 1 && Math.abs(leafletSize.y - containerRect.height) <= 1,
    `Leaflet's internal size should match the container's actual rendered size - container: ${JSON.stringify(containerRect)}, leaflet: ${JSON.stringify(leafletSize)}`
  );

  assertNoPageErrors(page);
  await browser.close();
});
