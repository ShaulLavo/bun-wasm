import assert from "node:assert/strict";
import { bodyControls } from "./controls.ts";
import { lifecycleControls } from "./lifecycle-controls.ts";
import { readFileSync } from "node:fs";
const lifecycleExpected = JSON.parse(readFileSync(new URL("./lifecycle-expected.json", import.meta.url), "utf8"));
if (process.argv.includes("--lifecycle")) {
  console.log(JSON.stringify(await lifecycleControls()));
  process.exit(0);
}
if (process.versions.bun) assert.deepEqual(await lifecycleControls(), lifecycleExpected);
const rows = await bodyControls();
const expected = ["type:null", "text:<h1>astro</h1>", "used:true", "clone:<h1>astro</h1>:<h1>astro</h1>", "closed:true", "error:true", "invalid:true:true", "plain:[object Object]"];
const common = (row: string) => !row.startsWith("closed:") && !row.startsWith("invalid:");
assert.deepEqual(rows.filter(common), expected.filter(common));
if (process.versions.bun) assert.deepEqual(rows, expected);
console.log(JSON.stringify(rows));
