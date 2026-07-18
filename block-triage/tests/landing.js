const { launch, assertNoPageErrors, landingUrl, assert, assertEqual, runTest } = require("./support");

runTest("landing: chooser page links to the full tool and the mobile view", async () => {
  const { browser, page } = await launch();

  await page.goto(landingUrl());
  await page.waitForTimeout(300);

  const links = await page.$$eval("a.choice", (els) => els.map((e) => e.getAttribute("href")));
  assert(links.includes("app.html"), `expected a link to app.html, got: ${JSON.stringify(links)}`);
  assert(links.includes("mobile.html"), `expected a link to mobile.html, got: ${JSON.stringify(links)}`);

  const appLink = await page.$('a.choice[href="app.html"]');
  await appLink.click();
  await page.waitForTimeout(500);
  assert((await page.url()).endsWith("app.html"), "clicking the full-tool choice should navigate to app.html");
  assert((await page.$("#file-input")) !== null, "app.html should be the full tool");

  assertNoPageErrors(page);
  await browser.close();
});
