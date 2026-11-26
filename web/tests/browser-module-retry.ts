import { browserType } from "./browser-type.ts";
import { navigateTestPage } from "./navigate-test-page.ts";
import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { session, ready, writeFile, run, terminalText } from "./playground.mjs";

const program = `
import { mkdirSync, writeFileSync } from "node:fs";
for (const retry of ["a", "b"]) {
  const dir = "retry-" + retry;
  mkdirSync(dir, { recursive: true });
  // Imports link backwards, so B must be cached before the missing import fails.
  writeFileSync(dir + "/a.mjs", 'import {missing} from "./missing.mjs"; import {b} from "./b.mjs"; export function a() { return "a"; } export const result = b() + missing;');
  writeFileSync(dir + "/b.mjs", 'import {a} from "./a.mjs"; export function b() { return a() + "b"; }');
  let failed = false;
  try { await import("./" + dir + "/a.mjs"); }
  catch (error) { if (!String(error.message).includes("missing.mjs")) throw error; failed = true; console.log("first load", retry, error.code, error.message); }
  if (!failed) throw new Error("missing import unexpectedly succeeded");
  writeFileSync(dir + "/missing.mjs", 'export const missing = ":fresh";');
  const loaded = await import("./" + dir + "/" + retry + ".mjs");
  const root = await import("./" + dir + "/a.mjs");
  if (root.result !== "ab:fresh") throw new Error("incorrect retry value " + root.result);
  if (retry === "b" && loaded.b() !== "ab") throw new Error("cached child did not recover");
  console.log("retry", retry, root.result);
}
`;

// Two CommonJS leaves: graph preparation checks both before either runs. The first throws; the
// page (not this process) then rewrites it, and the same graph is imported again, reusing its
// format records. The retry must run the new file, not the bytes read before the rewrite.
const cjsRetry = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("cjs-retry", { recursive: true });
writeFileSync("cjs-retry/bad.cjs", "throw new Error('old-code');");
writeFileSync("cjs-retry/other.cjs", "module.exports = 'other';");
writeFileSync("cjs-retry/graph.mjs", "import bad from './bad.cjs'; import other from './other.cjs'; export default bad + ':' + other;");
try { await import("./cjs-retry/graph.mjs"); throw new Error("old code unexpectedly loaded"); }
catch (error) { console.log("cjs first", error.message); }
while (!existsSync("cjs-retry/go")) await new Promise((resolve) => setTimeout(resolve, 20));
console.log("cjs file", JSON.stringify(require("node:fs").readFileSync("cjs-retry/bad.cjs", "utf8")));
console.log("cjs retry", (await import("./cjs-retry/graph.mjs")).default);
`;

/** Runs the two-leaf CommonJS retry, rewriting bad.cjs through the page once the first import failed. */
async function checkCjsRetry(page: Parameters<typeof run>[0]) {
  await writeFile(page, "/home/user/cjs-retry.ts", cjsRetry);
  const running = run(page, "bun run cjs-retry.ts", 120000);
  for (let waited = 0; !(await terminalText(page)).includes("cjs first old-code"); waited += 50) {
    if (waited > 90000) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await writeFile(page, "/home/user/cjs-retry/bad.cjs", "module.exports = 'fixed';");
  await writeFile(page, "/home/user/cjs-retry/go", "");
  return running;
}

const failures: string[] = [];
const s = session("bun-wasm-module-retry-");
const deadline = setTimeout(() => { void s.cleanup().finally(() => process.exit(1)); }, 300000);
try {
  const url = await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    const browser: Browser = await s.launch(browserType(name));
    const page = await browser.newPage();
    const httpErrors: string[] = [];
    page.on("response", response => { if (response.status() >= 400 && response.url().includes("/__bunwasm/m/")) httpErrors.push(`${response.status()} sw=${response.fromServiceWorker()} ${response.url()}`); });
    await navigateTestPage(page, `${url}?engine=browser&prompt=off`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, "/home/user/module-retry.ts", program);
    const checked = await run(page, "bun run module-retry.ts");
    console.log(JSON.stringify({ browser: name, httpErrors, ...checked }));
    if (checked.code !== 0 || httpErrors.length || !["a", "b"].every(entry => checked.output.includes(`retry ${entry} ab:fresh`))) failures.push(`${name}: ${checked.output} ${httpErrors.join("; ")}`);
    const cjs = await checkCjsRetry(page);
    console.log(JSON.stringify({ browser: name, cjs }));
    if (cjs.code !== 0 || !cjs.output.includes("cjs retry fixed:other")) failures.push(`${name} cjs retry: ${cjs.output}`);
    await browser.close();
  }
  assert.deepEqual(failures, []);
} finally { clearTimeout(deadline); await s.cleanup(); }
