import { browserType } from "./browser-type.ts";
import assert from "node:assert/strict";
import { session } from "./playground.mjs";
import { checkDelayedStop, checkRootSignals } from "./shell-stop-check";

const s = session("bun-wasm-shell-stop-");
const outcomes: { name: string; idle: boolean }[] = [];

try {
  const base = await s.serve();
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    const browser = await s.launch(browserType(name));
    const page = await browser.newPage();
    for (const engine of ["quickjs", "jsc", "browser"]) {
      outcomes.push({ name: `${name}/${engine}`, idle: await checkDelayedStop(page, base, name, engine) });
      await checkRootSignals(page, base, name, engine);
    }
    await browser.close();
  }
  assert.deepEqual(outcomes.filter(outcome => !outcome.idle), []);
} finally { await s.cleanup(); }
