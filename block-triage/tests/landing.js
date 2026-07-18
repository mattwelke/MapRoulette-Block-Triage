const { launch, assertNoPageErrors, landingUrl, assert, runTest } = require("./support");

runTest("landing: chooser page links to local file triage and live MapRoulette editing", async () => {
  const { browser, page } = await launch();

  await page.goto(landingUrl());
  await page.waitForTimeout(300);

  const links = await page.$$eval("a.choice", (els) => els.map((e) => e.getAttribute("href")));
  assert(links.includes("local.html"), `expected a link to local.html, got: ${JSON.stringify(links)}`);
  assert(links.includes("live.html"), `expected a link to live.html, got: ${JSON.stringify(links)}`);

  const localLink = await page.$('a.choice[href="local.html"]');
  await localLink.click();
  await page.waitForTimeout(500);
  assert((await page.url()).endsWith("local.html"), "clicking the local-file-triage choice should navigate to local.html");
  assert((await page.$("#file-input")) !== null, "local.html should be the local file triage tool");

  await page.goBack();
  await page.waitForTimeout(300);
  const liveLink = await page.$('a.choice[href="live.html"]');
  await liveLink.click();
  await page.waitForTimeout(500);
  assert((await page.url()).endsWith("live.html"), "clicking the live-MapRoulette-editing choice should navigate to live.html");
  assert((await page.$("#mr-load-challenge-btn")) !== null, "live.html should be the live MapRoulette editing tool");
  assert((await page.$("#file-input")) === null, "live.html should have no file-input - it only loads via the API");

  assertNoPageErrors(page);
  await browser.close();
});
