import { parseEnv } from "node:util";
import assert from "node:assert/strict";

const values = parseEnv("VITE_APP=hello\nQUOTED=\"hello world\"\n");
assert.equal(values.VITE_APP, "hello");
assert.equal(values.QUOTED, "hello world");
console.log("parseEnv named ESM export: pass");
