const { launch, assertNoPageErrors, indexUrl, fixturePath, assert, assertEqual, runTest } = require("./support");

runTest("mr-toggle: live sync off is pure-local, on reveals MR actions, state persists", async () => {
  const { browser, page } = await launch();
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto(indexUrl());
  await page.waitForTimeout(500);

  assert(!(await page.$eval("#mr-live-sync-checkbox", (el) => el.checked)), "live sync should default to off");
  assert(await page.$eval("#mr-live-panel", (el) => el.hidden), "MR panel should be hidden by default");
  assert(await page.$eval("#mr-live-banner", (el) => el.hidden), "the live banner should be hidden by default");

  await page.setInputFiles("#file-input", fixturePath("mr-challenge-sample.geojson"));
  await page.waitForTimeout(1500);

  const rows = await page.$$(".feature-row");
  await rows[rows.length - 1].click();
  await page.waitForTimeout(300);
  assert((await page.$("[data-mr-action]")) === null, "no mr-action button should appear while live sync is off");

  dialogs.length = 0;
  await page.click("[data-split]");
  await page.waitForTimeout(300);
  assertEqual(dialogs.length, 0, "splitting a task-linked area with live sync off should not ask an MR confirm");
  assert(!(await page.$eval("#draw-status", (el) => el.hidden)), "draw mode should start directly with no confirm needed");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  await page.click("#mr-live-sync-checkbox");
  await page.waitForTimeout(200);
  assert(!(await page.$eval("#mr-live-panel", (el) => el.hidden)), "MR panel should reveal once live sync is on");
  assert(!(await page.$eval("#mr-live-banner", (el) => el.hidden)), "the live banner should show once live sync is on");
  assertEqual(await page.$eval("#mr-live-banner-challenge", (el) => el.textContent), "90001", "banner should show the active challenge ID");

  await page.click(".feature-row");
  await page.waitForTimeout(300);
  assert((await page.$("[data-mr-action]")) !== null, "mr-action button should appear once live sync is on");

  dialogs.length = 0;
  await page.click("[data-split]");
  await page.waitForTimeout(300);
  assertEqual(dialogs.length, 1, "splitting a task-linked area with live sync on should ask for confirmation");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForTimeout(500);
  assert(await page.$eval("#mr-live-sync-checkbox", (el) => el.checked), "live sync toggle should persist across a reload");
  assert(!(await page.$eval("#mr-live-panel", (el) => el.hidden)), "the panel should still be visible after reload");

  assertNoPageErrors(page);
  await browser.close();
});
