// Shared-group browser-guest check: the explicitly selected group guest on the production Browser host.
// The shared PIC job passes its one group build in BUN_WASM_PROFILE_PROGRAM. A missing or
// mismatched program fails this gate; it is never a passing skip.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { programKind, programProfile, sharedGroupPair } from "../src/engine-kind.ts";

const root = resolve(import.meta.dir, "..");

test("the shared Wasm memory fixture passes in a real group guest on the Browser host", () => {
  for (const name of ["SHARED_WASM_CONTROL", "SHARED_WASM_ENTRY", "SHARED_WASM_OXC_TREE"]) {
    if (Object.hasOwn(process.env, name)) throw new Error(`Shared-group qualification refuses diagnostic override: ${name}`);
  }
  const program = process.env.BUN_WASM_PROFILE_PROGRAM;
  if (!program) throw new Error("Set BUN_WASM_PROFILE_PROGRAM to a matching shared-group guest");
  const core = new WebAssembly.Module(readFileSync(program));
  const kind = programKind(core);
  if (kind === "single") throw new Error("Set BUN_WASM_PROFILE_PROGRAM to a paired shared-group guest");
  const side = readFileSync(join(dirname(program), programProfile(kind).side));
  expect(sharedGroupPair(core, side)).toBe(true);
  execFileSync(process.execPath, ["tests/shared-wasm-memory-browser.ts", "chromium"], { cwd: join(root, "web"), stdio: "inherit", env: process.env });
}, 330_000);
