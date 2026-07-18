const { launch, assertNoPageErrors, liveUrl, assertEqual, runTest } = require("./support");

runTest("mr-from-header: every MapRoulette request carries the From header", async () => {
  const { browser, page } = await launch();

  let capturedFromHeader = null;
  await page.route("https://maproulette.org/api/v2/user/whoami", async (route) => {
    capturedFromHeader = route.request().headers()["from"];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: 1, osmProfile: { displayName: "TronnaLegacy" } }),
    });
  });

  await page.goto(liveUrl());
  await page.waitForTimeout(500);
  await page.fill("#mr-api-key-input", "fake-test-key");
  await page.$eval("#mr-api-key-input", (el) => el.dispatchEvent(new Event("change")));
  await page.click("#mr-test-btn");
  await page.waitForTimeout(500);

  assertEqual(capturedFromHeader, "Block Triage - tronnalegacy@pm.me", "the From header should identify this tool");
  assertEqual(await page.$eval("#mr-status", (el) => el.textContent), "Connected as TronnaLegacy.", "Test connection should succeed");

  assertNoPageErrors(page);
  await browser.close();
});
