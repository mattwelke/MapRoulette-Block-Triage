// Runs every test file in this directory (except this one and support.js) as
// a separate process, in sequence, and reports a pass/fail summary.
//
// Usage: node tests/run-all.js
// Config: PW_EXECUTABLE_PATH / PW_PROXY_SERVER (see support.js)

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".js") && f !== "run-all.js" && f !== "support.js")
  .sort();

const results = [];
for (const file of files) {
  const fullPath = path.join(dir, file);
  process.stdout.write(`\n=== ${file} ===\n`);
  const res = spawnSync(process.execPath, [fullPath], { stdio: "inherit" });
  results.push({ file, ok: res.status === 0 });
}

console.log("\n--- Summary ---");
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.file}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
