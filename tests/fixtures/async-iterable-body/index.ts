import assert from "node:assert/strict";
import { bodyControls } from "./controls.ts";
const rows = await bodyControls();
const expected = ["type:null", "text:<h1>astro</h1>", "used:true", "clone:<h1>astro</h1>:<h1>astro</h1>", "closed:true", "error:true", "invalid:true:true", "plain:[object Object]"];
const common = (row: string) => !row.startsWith("closed:") && !row.startsWith("invalid:");
assert.deepEqual(rows.filter(common), expected.filter(common));
if (process.versions.bun) assert.deepEqual(rows, expected);
console.log(JSON.stringify(rows));
