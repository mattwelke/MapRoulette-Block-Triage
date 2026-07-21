const {
  launch,
  assertNoPageErrors,
  landingUrl,
  localUrl,
  liveUrl,
  assert,
  assertEqual,
  runTest,
} = require("./support");

// Reads the *actual rendered* background color rather than trusting the
// data-theme attribute or CSS variable text, so this test catches a broken
// selector/media query, not just a JS bug in theme.js.
async function bodyBackground(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

const LIGHT_BG = "rgb(255, 255, 255)";
const INDEX_LIGHT_BG = "rgb(250, 250, 250)"; // index.html's own --bg-page default (#fafafa)
const DARK_BG = "rgb(18, 18, 18)"; // #121212

runTest("theme-toggle: follows the system preference with no stored choice (Auto)", async () => {
  {
    const { browser, page } = await launch({ colorScheme: "light" });
    await page.goto(liveUrl());
    await page.waitForTimeout(300);
    assertEqual(await bodyBackground(page), LIGHT_BG, "should be light when the system prefers light and nothing is stored");
    assertEqual(
      await page.$eval("#theme-toggle-btn", (el) => el.textContent),
      "Theme: Auto (Light)",
      "toggle button should show Auto (Light)"
    );
    assertNoPageErrors(page);
    await browser.close();
  }
  {
    const { browser, page } = await launch({ colorScheme: "dark" });
    await page.goto(liveUrl());
    await page.waitForTimeout(300);
    assertEqual(await bodyBackground(page), DARK_BG, "should be dark when the system prefers dark and nothing is stored");
    assertEqual(
      await page.$eval("#theme-toggle-btn", (el) => el.textContent),
      "Theme: Auto (Dark)",
      "toggle button should show Auto (Dark)"
    );
    assertNoPageErrors(page);
    await browser.close();
  }
});

runTest("theme-toggle: the manual toggle cycles Auto -> Light -> Dark -> Auto and persists across reloads", async () => {
  const { browser, page } = await launch({ colorScheme: "dark" }); // system prefers dark throughout

  await page.goto(liveUrl());
  await page.waitForTimeout(300);
  assertEqual(await bodyBackground(page), DARK_BG, "starts in Auto, which is dark here since the system prefers dark");

  // Auto -> Light (explicit override, opposing the system preference).
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(150);
  assertEqual(await bodyBackground(page), LIGHT_BG, "should force light even though the system prefers dark");
  assertEqual(await page.$eval("#theme-toggle-btn", (el) => el.textContent), "Theme: Light");
  assertEqual(await page.evaluate(() => localStorage.getItem("block-triage:theme")), "light");

  // Reload - the explicit choice should survive.
  await page.reload();
  await page.waitForTimeout(300);
  assertEqual(await bodyBackground(page), LIGHT_BG, "explicit Light should persist across a reload");

  // Light -> Dark.
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(150);
  assertEqual(await bodyBackground(page), DARK_BG, "should be dark after cycling to Dark");
  assertEqual(await page.$eval("#theme-toggle-btn", (el) => el.textContent), "Theme: Dark");
  assertEqual(await page.evaluate(() => localStorage.getItem("block-triage:theme")), "dark");

  // Dark -> Auto (clears the stored preference; still dark here since the
  // system itself prefers dark).
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(150);
  assertEqual(await bodyBackground(page), DARK_BG, "Auto should resolve to dark since the system prefers dark");
  assertEqual(await page.$eval("#theme-toggle-btn", (el) => el.textContent), "Theme: Auto (Dark)");
  assertEqual(await page.evaluate(() => localStorage.getItem("block-triage:theme")), null, "Auto should clear the stored preference");

  assertNoPageErrors(page);
  await browser.close();
});

runTest("theme-toggle: index.html and local.html also respect Auto and the toggle", async () => {
  const { browser, page } = await launch({ colorScheme: "dark" });

  await page.goto(landingUrl());
  await page.waitForTimeout(300);
  assertEqual(await bodyBackground(page), DARK_BG, "index.html should be dark under Auto with a dark system preference");
  await page.click("#theme-toggle-btn");
  await page.waitForTimeout(150);
  assertEqual(await bodyBackground(page), INDEX_LIGHT_BG, "index.html should force light when toggled");

  await page.goto(localUrl());
  await page.waitForTimeout(300);
  // The choice made on index.html carries over (same localStorage, same origin).
  assertEqual(await bodyBackground(page), LIGHT_BG, "local.html should reflect the same stored preference as index.html");

  assertNoPageErrors(page);
  await browser.close();
});
