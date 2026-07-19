const fs = require("fs");
const path = require("path");
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

const REPO_ROOT = path.join(__dirname, "..");

runTest("pwa-manifest: manifest.json is valid and its icons exist on disk", async () => {
  const manifestPath = path.join(REPO_ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assertEqual(manifest.display, "standalone", "display should be standalone for a full-screen add-to-home-screen experience");
  assert(manifest.name && manifest.short_name, "manifest should have a name and short_name");
  assert(manifest.start_url, "manifest should have a start_url");
  assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, "manifest should list at least one icon");

  const sizesPresent = manifest.icons.map((i) => i.sizes);
  assert(sizesPresent.includes("192x192"), `expected a 192x192 icon, got sizes: ${JSON.stringify(sizesPresent)}`);
  assert(sizesPresent.includes("512x512"), `expected a 512x512 icon, got sizes: ${JSON.stringify(sizesPresent)}`);
  assert(
    manifest.icons.some((i) => (i.purpose || "").includes("maskable")),
    "expected at least one maskable icon for Android adaptive icons"
  );

  manifest.icons.forEach((icon) => {
    const iconPath = path.join(REPO_ROOT, icon.src);
    assert(fs.existsSync(iconPath), `manifest references ${icon.src} but it doesn't exist on disk`);
  });
});

runTest("pwa-manifest: every page links the manifest and sets a theme color", async () => {
  const { browser, page } = await launch();

  for (const [label, url] of [
    ["index.html", landingUrl()],
    ["local.html", localUrl()],
    ["live.html", liveUrl()],
  ]) {
    await page.goto(url);
    await page.waitForTimeout(200);

    const manifestHref = await page.$eval('link[rel="manifest"]', (el) => el.getAttribute("href")).catch(() => null);
    assertEqual(manifestHref, "manifest.json", `${label} should link manifest.json`);

    const themeColor = await page.$eval('meta[name="theme-color"]', (el) => el.getAttribute("content")).catch(() => null);
    assert(!!themeColor, `${label} should set a theme-color meta tag`);
  }

  assertNoPageErrors(page);
  await browser.close();
});
