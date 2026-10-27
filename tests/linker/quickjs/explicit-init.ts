import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { convertEngineInitializers } from "../../../scripts/src/engine-explicit-init.ts";

const [input, output] = process.argv.slice(2);
assert(input && output, "usage: explicit-init.ts input.wasm output.wasm");
writeFileSync(output, convertEngineInitializers(readFileSync(input), "quickjs"));
