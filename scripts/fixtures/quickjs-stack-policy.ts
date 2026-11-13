import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const budget = process.env.QUICKJS_STACK_KIB;
const commands: string[] = [];
const inputs: { mode: string; depth: number }[] = [];
const fixtures = [
  { name: "stack-overflow", entry: "index.js" },
  { name: "stack-overflow-console", entry: "index.js" },
  { name: "parser-error-preservation", entry: "index.ts" },
  { name: "stack-statement-nesting", entry: "index.ts" },
];
const visitedFixtures: string[] = [];
const files = new Map<string, string>();
let opened = 0;
let closed = 0;
let cleanups = 0;
async function navigate(url: string, options: { waitUntil: string; timeout: number }): Promise<void> {
  assert.equal(url, "https://stack.test/?engine=quickjs&prompt=off&mode=memory");
  assert.deepEqual(options, { waitUntil: "domcontentloaded", timeout: 30_000 });
}

const browser = {
  browserType: () => ({ name: () => "webkit" }),
  async newContext(options: { userAgent: string }) {
    assert.match(options.userAgent, /Version\/26\.4 Safari\/605\.1\.15$/);
    opened++;
    return {
      async addInitScript(install: () => void) {
        install();
        assert.equal(navigator.platform, "MacIntel");
        assert.equal(navigator.vendor, "Apple Computer, Inc.");
        assert.equal(navigator.maxTouchPoints, 0);
      },
      async newPage() {
        files.clear();
        return { goto: navigate };
      },
      async close() { closed++; },
    };
  },
  async close() {},
};

mock.module("../../web/tests/playground.mjs", () => ({
  playwright: { webkit: {} },
  session: () => ({ launch: async () => browser, serve: async () => "https://stack.test/", cleanup: async () => { cleanups++; } }),
  ready: async (_page: unknown, timeout: number) => { assert.equal(timeout, 90_000); },
  writeFile: async (_page: unknown, path: string, source: string) => { files.set(path, source); },
  run: async (_page: unknown, command: string, timeout: number) => {
    assert.equal(timeout, 90_000);
    assert.equal(files.get("/home/user/depth.js"), readFileSync(new URL("../../tests/stack-depth.js", import.meta.url), "utf8"));
    if (command.includes("console.log(process.env.BUN_WASM_STACK_KIB)")) return { code: 0, output: "36" };
    commands.push(command);
    const probe = /bun run depth.js (\w+) (\d+)$/.exec(command);
    if (probe) {
      const [, mode = "", depth = ""] = probe;
      inputs.push({ mode, depth: Number(depth) });
      const output = mode === "console" || mode === "isarray" ? `completed ${mode} ${depth}` : `caught ${mode} RangeError`;
      return { code: 0, output: `${output}\ncontinued\n` };
    }
    if (command.endsWith("bun run control.ts")) return nativeFixture();
    const selected = fixtures.find(fixture => files.get(`/home/user/${fixture.entry}`) === fixtureSource(fixture));
    assert.ok(selected, "the original fixture source must be written");
    visitedFixtures.push(selected.name);
    return { code: 0, output: readFileSync(new URL(`../../tests/fixtures/${selected.name}/expected.txt`, import.meta.url), "utf8") };
  },
}));

function fixtureSource(fixture: (typeof fixtures)[number]): string {
  return readFileSync(new URL(`../../tests/fixtures/${fixture.name}/${fixture.entry}`, import.meta.url), "utf8");
}

function nativeFixture() {
  const base = new URL("../../tests/fixtures/stack-native-call/", import.meta.url);
  for (const name of ["control.ts", "semantics.ts"]) assert.equal(files.get(`/home/user/${name}`), readFileSync(new URL(name, base), "utf8"));
  return { code: 0, output: readFileSync(new URL("expected.txt", base), "utf8") };
}

process.argv = [process.execPath, "browser-quickjs-stack.ts", "webkit"];
await import("../../web/tests/browser-quickjs-stack.ts");
const originalModes = "plain getter proxy json jsonplain jsonparse reviver parse block arrow unary power ternary statement regexpnc lookahead proxychain isarray bound join flat tostring async promise console".split(" ");
const expectedCases = originalModes.length + fixtures.length + 1;
assert.deepEqual(visitedFixtures, fixtures.map(fixture => fixture.name));
assert.equal(opened, expectedCases + (budget ? 0 : 1));
assert.equal(closed, opened);
assert.equal(cleanups, 1);
assert.deepEqual(inputs, originalModes.map(mode => ({ mode, depth: mode === "bound" ? 2000 : 200000 })));
assert.equal(commands.filter(command => command.startsWith("BUN_WASM_STACK_KIB=32 ")).length, budget ? 0 : 1);
assert.equal(commands.filter(command => command.startsWith(`BUN_WASM_STACK_KIB=${budget} `)).length, budget ? expectedCases : 0);
console.log("POLICY_CONTROL_RESULT", JSON.stringify({ opened, closed, budget: budget ?? "policy", probes: inputs.length }));
