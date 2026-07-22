const { launch, assertNoPageErrors, landingUrl, localUrl, liveUrl, assert, assertEqual, runTest } = require("./support");

runTest("version-tooltip: no version.js present (dev/repo-root usage) leaves the title tooltip unset", async () => {
  const { browser, page } = await launch();

  await page.goto(landingUrl());
  await page.waitForTimeout(200);
  assertEqual(await page.$eval("#app-title", (el) => el.title), "", "index.html should have no version tooltip without version.js");

  await page.goto(localUrl());
  await page.waitForTimeout(300);
  assertEqual(await page.$eval("#app-title", (el) => el.title), "", "local.html should have no version tooltip without version.js");

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  assertEqual(await page.$eval("#app-title", (el) => el.title), "", "live.html should have no version tooltip without version.js");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("version-tooltip: a built version.js populates the title tooltip", async () => {
  const { browser, page } = await launch();

  // Simulates what build.js's generated version.js sets, since these tests
  // run straight off the repo root (no dist/ build), not a built deploy.
  await page.addInitScript(() => {
    window.__BLOCK_TRIAGE_VERSION__ = { version: "abc1234", builtAt: "2026-01-15T12:00:00.000Z" };
  });

  await page.goto(landingUrl());
  await page.waitForTimeout(200);
  let title = await page.$eval("#app-title", (el) => el.title);
  assert(title.includes("abc1234"), `expected the version in the tooltip, got: ${title}`);
  assert(title.includes("Block Triage"), `expected a friendly label in the tooltip, got: ${title}`);

  await page.goto(localUrl());
  await page.waitForTimeout(300);
  title = await page.$eval("#app-title", (el) => el.title);
  assert(title.includes("abc1234"), `expected the version in local.html's tooltip, got: ${title}`);

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  title = await page.$eval("#app-title", (el) => el.title);
  assert(title.includes("abc1234"), `expected the version in live.html's tooltip, got: ${title}`);

  assertNoPageErrors(page);
  await browser.close();
});
