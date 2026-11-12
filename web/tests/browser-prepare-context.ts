import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { playwright, ready, run, session, writeFile } from "./playground.mjs";
const fixtures = new URL("../../tests/async-context-runtime/", import.meta.url);
const files = ["prepare-probe.ts", "prepare-transforms.ts", "prepare-cache.ts", "prepare-parent-loop.ts", "eval-callsite.mjs", "escaped-callsite.mjs", "yield-callsite.mjs", "prepare-live-map.ts"];
const sources = await Promise.all(files.map(async (name): Promise<[string, string]> => [name, await readFile(new URL(name, fixtures), "utf8")]));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"];
const s = session("bun-wasm-prep-");
const cases: [string, string][] = [
  ["prepare-probe", "PREPARE_OK"], ["prepare-transforms", "PREPARE_TRANSFORMS_OK"], ["prepare-live-map", "PREPARE_LIVE_MAP_OK"], ["prepare-cache", "PREPARE_CACHE_OK"],
  ["prepare-parent-loop", '{"dynamicRows":["loop","loop"],"printedRows":["loop","loop"]}'],
];
async function exercise(name: string, appUrl: string): Promise<void> {
  if (name !== "chromium" && name !== "webkit") throw new Error(`unknown browser ${name}`);
  const browser = await s.launch(playwright[name]);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${appUrl}?engine=browser&prompt=off`);
    assert.match(await ready(page), /ready · Browser \(native\)/);
    for (const [file, source] of sources) await writeFile(page, `/home/user/prepare/${file}`, source);
    for (const [fixture, expected] of cases) {
      const result = await run(page, `bun run prepare/${fixture}.ts`);
      assert.equal(result.code, 0, `${name}/${fixture}: ${result.output}`);
      assert.ok(result.output.includes(expected), `${name}/${fixture}: ${result.output}`);
      console.log(JSON.stringify({ browser: name, fixture, status: "pass" }));
    }
  } finally {
    await context.close();
  }
}
try {
  const appUrl = await s.serve();
  for (const name of wanted) await exercise(name, appUrl);
} finally {
  await s.cleanup();
}
