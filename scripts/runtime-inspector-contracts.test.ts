import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const runtime = join(root, "crates/bunwasm-runtime/src/js");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-inspector-contracts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const compiler = process.env.BUN_WASM_TYPESCRIPT_COMPILER ?? join(root, "web/node_modules/.bin/tsc");
const all = readdirSync(runtime).filter(name => name.endsWith(".d.ts")).toSorted();

function check(declarations: readonly string[], source: string) {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(probe, source);
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
    include: [],
    files: declarations.map(name => resolve(runtime, name)).concat([probe]),
  }));
  const result = Bun.spawnSync([compiler, "-p", config]);
  return { exitCode: result.exitCode, diagnostics: result.stdout.toString() + result.stderr.toString() };
}

const common = `declare const internal: BunWasm.Internal;
const inspector = internal.require("inspect");
const inspect: BunWasm.InspectFunction = inspector.nodeInspect;
const simple: string = inspect({}, { depth: 0, compact: true, sorted: true, getters: false });
const rich: string = inspect({}, { depth: null, compact: 2, sorted: (a, b) => a.localeCompare(b), getters: "get" });
inspect({}, { getters: "set" });
inspect.defaultOptions = { depth: null, compact: 3, getters: "get" };
const defaults: BunWasm.InspectOptions | undefined = inspect.defaultOptions;
inspect.colors = { red: [31, 39] };
const colors: Record<string, number[]> | undefined = inspect.colors;
inspect.styles = { number: "yellow" };
const styles: Record<string, string> | undefined = inspect.styles;
inspector.nodeInspect = inspect;
inspect.defaultOptions = undefined;
inspect.colors = undefined;
inspect.styles = undefined;
const parsed: BunWasm.StackFrame[] = inspector.parseStack(undefined);
const capture: (target: object, constructor?: Function) => void = Error.captureStackTrace;
capture({});
process = process;
process.stdout = process.stdout;
process.stderr = process.stderr;
process.stdout.write("out");
process.stderr.write("err");
process.stdout.hasColors?.();
process.nextTick?.(() => {});
process.emitWarning?.(new Error("main"));
process.emitWarning?.("utility", "kind", "code");
const absent: BunWasm.RuntimeProcess = { cwd: () => "/" };
absent.emitWarning?.("optional");
internal.listenerChanged?.({}, Symbol("event"));
internal.listenerChanged = undefined;
`;

function positive(declarations: readonly string[]) {
  const consoleCalls = declarations.includes("console_types.d.ts") ? `
const options: BunWasm.ConsoleInspectOptions = { depth: 0, compact: true, sorted: false, getters: true };
inspect({}, options);
const formatted: string = inspector.formatArgs(["value"], options);
const bun: string = inspector.bunInspect({}, options);
` : "";
  const utilityCalls = declarations.includes("assert_util_types.d.ts") ? `
const formattedNode: string = inspector.nodeFormat("%s", 1);
const formattedOptions: string = inspector.nodeFormatWithOptions({ depth: null, compact: 2 }, "%s", 1);
` : "";
  const eventCalls = declarations.includes("events-types.d.ts") ? `
const asyncConstructor: BunWasm.Events.AsyncConstructor = internal.require("event_emitter_async_resource");
` : "";
  return common + consoleCalls + utilityCalls + eventCalls;
}

const orders = [
  ["runtime.d.ts"],
  ["runtime.d.ts", "console_types.d.ts"],
  ["console_types.d.ts", "runtime.d.ts"],
  ["runtime.d.ts", "events-types.d.ts"],
  ["events-types.d.ts", "runtime.d.ts"],
  ["runtime.d.ts", "assert_util_types.d.ts"],
  ["assert_util_types.d.ts", "runtime.d.ts"],
  ["runtime.d.ts", "console_types.d.ts", "events-types.d.ts"],
  ["runtime.d.ts", "events-types.d.ts", "console_types.d.ts"],
  ["console_types.d.ts", "runtime.d.ts", "events-types.d.ts"],
  ["console_types.d.ts", "events-types.d.ts", "runtime.d.ts"],
  ["events-types.d.ts", "runtime.d.ts", "console_types.d.ts"],
  ["events-types.d.ts", "console_types.d.ts", "runtime.d.ts"],
  ["runtime.d.ts", "console_types.d.ts", "events-types.d.ts", "assert_util_types.d.ts"],
  ["runtime.d.ts", "console_types.d.ts", "assert_util_types.d.ts", "events-types.d.ts"],
  ["runtime.d.ts", "events-types.d.ts", "console_types.d.ts", "assert_util_types.d.ts"],
  ["runtime.d.ts", "events-types.d.ts", "assert_util_types.d.ts", "console_types.d.ts"],
  ["runtime.d.ts", "assert_util_types.d.ts", "console_types.d.ts", "events-types.d.ts"],
  ["runtime.d.ts", "assert_util_types.d.ts", "events-types.d.ts", "console_types.d.ts"],
  all,
  all.toReversed(),
];
for (const declarations of orders) {
  test(`shared callable compiles with ${declarations.join(" before ")}`, () => {
    const result = check(declarations, positive(declarations));
    expect(result.diagnostics).toBe("");
    expect(result.exitCode).toBe(0);
  });
}

test("reproduces both actual TS2300 sites from the former inspector method/property union", () => {
  const legacyRuntime = join(scratch, "runtime.d.ts");
  const legacyConsole = join(scratch, "console_types.d.ts");
  const legacyUtility = join(scratch, "assert_util_types.d.ts");
  const property = "    nodeInspect: InspectFunction;\n";
  const current = readFileSync(join(runtime, "runtime.d.ts"), "utf8");
  expect(current).toContain(property);
  writeFileSync(legacyRuntime, current.replace(property, ""));
  const consoleSource = readFileSync(join(runtime, "console_types.d.ts"), "utf8");
  writeFileSync(legacyConsole, consoleSource.replace("  interface ConsoleInspector {", "  interface ConsoleInspector {\n    nodeInspect(value: unknown, options?: ConsoleInspectOptions): string;"));
  const utilitySource = readFileSync(join(runtime, "assert_util_types.d.ts"), "utf8");
  writeFileSync(legacyUtility, utilitySource.replace("  interface ConsoleInspector {", "  interface ConsoleInspector {\n" + property.trimEnd()));
  const result = check([legacyRuntime, legacyConsole, legacyUtility], "");
  expect(result.exitCode).not.toBe(0);
  expect(result.diagnostics).toMatch(/console_types\.d\.ts\(\d+,\d+\): error TS2300: Duplicate identifier 'nodeInspect'/);
  expect(result.diagnostics).toMatch(/assert_util_types\.d\.ts\(\d+,\d+\): error TS2300: Duplicate identifier 'nodeInspect'/);
});

const invalid: [string, string][] = [
  ['internal.require("inspect").nodeInspect({}, { depth: "deep" });', "2322"],
  ['internal.require("inspect").nodeInspect({}, { compact: "yes" });', "2322"],
  ['internal.require("inspect").nodeInspect({}, { getters: "all" });', "2322"],
  ['internal.require("inspect").nodeInspect({}, { sorted: (a: string) => a });', "2322"],
  ['internal.require("inspect").nodeInspect.defaultOptions = { depth: "deep" };', "2322"],
  ['internal.require("inspect").nodeInspect.colors = { red: "31" };', "2322"],
  ['internal.require("inspect").nodeInspect.styles = { number: 1 };', "2322"],
  ['process.emitWarning?.(1);', "2769"],
  ['process.emitWarning?.("warning", 1);', "2345"],
  ['process.emitWarning?.(new Error("warning"), "kind");', "2345"],
  ['process.emitWarning("warning");', "2722"],
];
for (const declarations of [all, all.toReversed()]) {
  test(`invalid callable and warning calls fail with real diagnostics in ${declarations[0]} order`, () => {
    const lines = invalid.map(([source]) => source);
    const result = check(declarations, 'declare const internal: BunWasm.Internal;\n' + lines.join("\n"));
    expect(result.exitCode).not.toBe(0);
    invalid.forEach(([, code], index) => {
      expect(result.diagnostics).toMatch(new RegExp(`probe\\.ts\\(${index + 2},\\d+\\): error TS${code}:`));
    });
    expect(result.diagnostics.match(/error TS/g)).toHaveLength(invalid.length);
  });
}
