import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { verifyVMContexts } from "../tests/fixtures/vm-context/contract";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url), "utf8");

test("production VM factory keeps context-global writes outside the caller realm", () => {
  const realm = createContext({});
  const factory: unknown = runInContext(source, realm);
  assert.ok(typeof factory === "function");
  const registry: Record<string, unknown> = {};
  factory({ builtinFactories: registry, native: { evalScript: (code: string, filename: string) => runInContext(code, realm, { filename }) } });
  const makeVM = registry["node:vm"];
  assert.ok(typeof makeVM === "function");
  const vm: unknown = makeVM();
  assert.ok(vm && typeof vm === "object");
  const outer: unknown = runInContext("globalThis", realm);
  assert.ok(outer && typeof outer === "object");
  verifyVMContexts(vm, outer);
  expect(Object.hasOwn(outer, "__bunwasm_vm_context_marker__")).toBe(false);
});
