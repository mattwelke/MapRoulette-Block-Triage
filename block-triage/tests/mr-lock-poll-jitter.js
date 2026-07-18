const {
  launch,
  assertNoPageErrors,
  liveUrl,
  assert,
  runTest,
  mrChallengeSampleTasks,
  routeMrChallenge,
  loadLiveChallenge,
} = require("./support");

const CHALLENGE_ID = 77001;

runTest("mr-lock-poll-jitter: the background poll interval varies, not a fixed 60000ms", async () => {
  const { browser, page } = await launch();

  // Record every setTimeout delay used anywhere in the app, before live.js
  // runs, so we can inspect what scheduleMrLockPoll actually passed in.
  await page.addInitScript(() => {
    window.__delays = [];
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function (fn, delay, ...args) {
      window.__delays.push(delay);
      return origSetTimeout(fn, delay, ...args);
    };
  });

  await routeMrChallenge(page, CHALLENGE_ID, mrChallengeSampleTasks());

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  await loadLiveChallenge(page, CHALLENGE_ID, "fake-test-key");

  // Re-firing the challenge ID field's change event re-triggers
  // kickMrLockPoll -> scheduleMrLockPoll each time (same as changing it would),
  // so this collects several independent samples of the delay chosen.
  for (let i = 0; i < 6; i++) {
    await page.$eval("#mr-challenge-id-input", (el) => el.dispatchEvent(new Event("change")));
    await page.waitForTimeout(150);
  }

  const delays = await page.evaluate(() => window.__delays);
  const lockPollDelays = delays.filter((d) => d >= 55000 && d <= 65000);
  const uniqueValues = new Set(lockPollDelays);

  assert(lockPollDelays.length > 0, "expected at least one lock-poll-range delay to have been recorded");
  assert(
    uniqueValues.size > 1,
    `expected multiple distinct delay values (proving jitter, not a fixed 60000ms), got: ${JSON.stringify(lockPollDelays)}`
  );
  assert(
    lockPollDelays.every((d) => d >= 55000 && d <= 65000),
    `all delays should stay within the documented +/-5s window of 60000ms, got: ${JSON.stringify(lockPollDelays)}`
  );

  assertNoPageErrors(page);
  await browser.close();
});
