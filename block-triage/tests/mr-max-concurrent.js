const { launch, assertNoPageErrors, liveUrl, assert, assertEqual, runTest } = require("./support");

runTest("mr-max-concurrent: configurable input persists and caps the request semaphore", async () => {
  const { browser, page } = await launch();

  await page.goto(liveUrl());
  await page.waitForTimeout(300);

  assertEqual(
    await page.$eval("#mr-max-concurrent-input", (el) => el.value),
    "3",
    "expected the default max-concurrent-requests value to be 3"
  );

  await page.fill("#mr-max-concurrent-input", "2");
  await page.$eval("#mr-max-concurrent-input", (el) => el.dispatchEvent(new Event("change")));
  await page.waitForTimeout(100);

  assertEqual(
    await page.evaluate(() => localStorage.getItem("block-triage:mrMaxConcurrent")),
    "2",
    "expected the new max-concurrent value to persist to localStorage"
  );

  // Directly exercise the semaphore: with a cap of 2, a 3rd acquire should
  // stay pending until one of the first two releases.
  const result = await page.evaluate(async () => {
    const { acquireMrSlot, releaseMrSlot, getActive } = window.__blockTriageMrSlotTest;
    await acquireMrSlot();
    await acquireMrSlot();
    let thirdAcquired = false;
    const thirdPromise = acquireMrSlot().then(() => {
      thirdAcquired = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    const activeBeforeRelease = getActive();
    const thirdAcquiredBeforeRelease = thirdAcquired;
    releaseMrSlot();
    await thirdPromise;
    return { activeBeforeRelease, thirdAcquiredBeforeRelease, activeAfter: getActive() };
  });

  assertEqual(result.activeBeforeRelease, 2, "expected exactly 2 active slots while the cap of 2 is full");
  assert(!result.thirdAcquiredBeforeRelease, "a 3rd acquire should stay pending while the cap of 2 is full");
  assertEqual(result.activeAfter, 2, "expected 2 active slots again once the 3rd acquire took the freed one");

  // Reload and confirm the persisted value comes back.
  await page.reload();
  await page.waitForTimeout(300);
  assertEqual(
    await page.$eval("#mr-max-concurrent-input", (el) => el.value),
    "2",
    "expected the persisted max-concurrent value to survive a reload"
  );

  assertNoPageErrors(page);
  await browser.close();
});
