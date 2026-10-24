import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-runtime-types-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const probe = join(scratch, "probe.ts");
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
  include: [],
  files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), probe],
}));

function check(source: string) {
  writeFileSync(probe, 'declare const native: BunWasm.Native;\n' + source);
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("accepts the positional glob native contract including its optional flag", () => {
  expect(check('native.globScan("*", "/", false, false, false, false, true);\nnative.globScan("*", "/", false, false, false, false, true, true);').exitCode).toBe(0);
});

const invalid: [string, string][] = [
  ["missing cwd", 'native.globScan("*");'],
  ["boolean cwd", 'native.globScan("*", true, false, false, false, false, true);'],
  ["string flag", 'native.globScan("*", "/", "not a flag", false, false, false, true);'],
  ["string optional flag", 'native.globScan("*", "/", false, false, false, false, true, "not a flag");'],
  ["non-string UTF-8 encoding", 'native.utf8Encode(7);'],
  ["non-byte concatenation", 'declare const internal: BunWasm.Internal; internal.concatBytes(["text"]);'],
  ["unknown generated-function kind", 'native.functionImports([], "constructor");'],
  ["non-string module specifier", 'native.resolve(7, "/index.ts", false);'],
  ["builtin index text", 'native.bunBuiltinSource("module");'],
  ["builtin hook object", 'native.bunBuiltinHookName({});'],
  ["stack frame text", 'declare const internal: BunWasm.Internal; internal.formatCallSite("not a frame");'],
  ["stack target primitive", 'Error.captureStackTrace(7);'],
  ["runtime type error", 'const value: number = "wrong";'],
];
for (const [label, source] of invalid) {
  test(`rejects ${label}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

test("accepts native byte-sink encoding and concatenation contracts", () => {
  expect(check('native.utf8Encode("text");\ndeclare const internal: BunWasm.Internal;\ninternal.concatBytes([new Uint8Array(2)]);').exitCode).toBe(0);
});

test("accepts generated-function parser and module-loader contracts", () => {
  const result = check('native.functionImports(["return 1"], "normal");\nnative.importModule(native.resolve("./x", "/index.ts", false));');
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("accepts builtin registry and structured stack contracts", () => {
  const result = check('native.bunBuiltinSource(0);\nnative.evalScript("(function () {})", "bun-builtin:example")({});\ndeclare const internal: BunWasm.Internal;\ninternal.require("inspect").parseStack(undefined);\nError.captureStackTrace({});\nError.prepareStackTrace = (_target, raw) => raw;');
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});


test("accepts format graph, boxed coercion and shared buffer input contracts", () => {
  const result = check('native.parseData(new Uint8Array(), "YAML");\ndeclare const internal: BunWasm.Internal;\ninternal.require("yaml_coercion")(new String("value"));\ninternal.toUint8(new SharedArrayBuffer(4));\ninternal.require("formats_limit").checkSize({ byteLength: 2147483648 });');
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

for (const source of ['native.parseData("bytes", "YAML");', 'native.parseData(new Uint8Array(), "CSV");', 'native.parseData({ byteLength: 1 }, "YAML");', 'declare const internal: BunWasm.Internal; internal.require("formats_limit").checkSize({ byteLength: "1" });']) {
  test(`rejects invalid format graph call ${source}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

for (const declarations of [
  ["runtime.d.ts", "console_types.d.ts", "events-types.d.ts"],
  ["runtime.d.ts", "events-types.d.ts", "console_types.d.ts"],
  ["console_types.d.ts", "runtime.d.ts", "events-types.d.ts"],
  ["console_types.d.ts", "events-types.d.ts", "runtime.d.ts"],
  ["events-types.d.ts", "runtime.d.ts", "console_types.d.ts"],
  ["events-types.d.ts", "console_types.d.ts", "runtime.d.ts"],
]) {
  test(`accepts all four inspector APIs with ${declarations.join(" before ")}`, () => {
    const inspectorProbe = join(scratch, "inspector-probe.ts");
    const inspectorConfig = join(scratch, "inspector-tsconfig.json");
    writeFileSync(inspectorProbe, `
      declare const internal: BunWasm.Internal;
      const parsedStackFrames: BunWasm.StackFrame[] = internal.require("inspect").parseStack(undefined);
      const formatted: string = internal.require("inspect").formatArgs(["value", 1]);
      const inspected: string = internal.require("inspect").bunInspect({}, { depth: 0, compact: true });
      const nodeInspected: string = internal.require("inspect").nodeInspect({}, { depth: 0, compact: true });
      const inspector: BunWasm.ConsoleInspector = internal.require("inspect");
      const nodeInspect: BunWasm.ConsoleInspector["nodeInspect"] = inspector.nodeInspect;
      const warningResult: void | undefined = process.emitWarning?.(new Error("warning"));
      process.stdout.write(formatted);
      process.stderr.write(nodeInspected);
    `);
    writeFileSync(inspectorConfig, JSON.stringify({
      extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
      include: [],
      files: declarations.map(name => join(root, "crates/bunwasm-runtime/src/js", name)).concat([inspectorProbe]),
    }));
    const result = Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", inspectorConfig], { stdout: "pipe", stderr: "pipe" });
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
}

function checkListenerHook(declarations: readonly string[], source: string) {
  const hookProbe = join(scratch, "listener-hook-probe.ts");
  const hookConfig = join(scratch, "listener-hook-tsconfig.json");
  writeFileSync(hookProbe, source);
  writeFileSync(hookConfig, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
    include: [],
    files: declarations.map(name => resolve(root, "crates/bunwasm-runtime/src/js", name)).concat([hookProbe]),
  }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", hookConfig], { stdout: "pipe", stderr: "pipe" });
}

test("reproduces TS2300 for the former listener hook method/property union", async () => {
  const legacy = join(scratch, "legacy-events-types.d.ts");
  const current = await Bun.file(join(root, "crates/bunwasm-runtime/src/js/events-types.d.ts")).text();
  const property = "listenerChanged?: (target: object, name?: string | symbol) => void;";
  expect(current).toContain(property);
  writeFileSync(legacy, current.replace(property, "listenerChanged?(target: object, type?: Events.Name): void;"));
  const result = checkListenerHook(["runtime.d.ts", legacy], "");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toContain("error TS2300: Duplicate identifier 'listenerChanged'");
});

for (const declarations of [
  ["runtime.d.ts"],
  ["runtime.d.ts", "events-types.d.ts"],
  ["events-types.d.ts", "runtime.d.ts"],
  ["runtime.d.ts", "console_types.d.ts", "events-types.d.ts"],
  ["runtime.d.ts", "events-types.d.ts", "console_types.d.ts"],
  ["console_types.d.ts", "runtime.d.ts", "events-types.d.ts"],
  ["console_types.d.ts", "events-types.d.ts", "runtime.d.ts"],
  ["events-types.d.ts", "runtime.d.ts", "console_types.d.ts"],
  ["events-types.d.ts", "console_types.d.ts", "runtime.d.ts"],
]) {
  test(`accepts optional listener hook with ${declarations.join(" before ")}`, () => {
    const result = checkListenerHook(declarations, `
      type Hook = Pick<BunWasm.Internal, "listenerChanged">;
      const absent: Hook = {};
      const unset: Hook = { listenerChanged: undefined };
      const installed: Hook = { listenerChanged(target, name) {
        const objectTarget: object = target;
        const eventName: string | symbol | undefined = name;
      } };
      declare const internal: BunWasm.Internal;
      internal.listenerChanged = installed.listenerChanged;
      const callback: ((target: object, name?: string | symbol) => void) | undefined = internal.listenerChanged;
      internal.listenerChanged?.({});
      internal.listenerChanged?.({}, "event");
      internal.listenerChanged?.({}, Symbol("event"));
      internal.listenerChanged?.({}, undefined);
      internal.listenerChanged = undefined;
      delete internal.listenerChanged;
      absent.listenerChanged?.({});
      unset.listenerChanged?.({});
    `);
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test(`rejects changes to listener hook domain with ${declarations.join(" before ")}`, () => {
    const invalidHooks = [
      "internal.listenerChanged?.(1);",
      "internal.listenerChanged?.({}, 1);",
      "internal.listenerChanged = (target: object, name: string) => {};",
      "internal.listenerChanged = (target: { required: true }, name?: string | symbol) => {};",
      "internal.listenerChanged({});",
    ];
    for (const source of invalidHooks) {
      const result = checkListenerHook(declarations, "declare const internal: BunWasm.Internal;\n" + source);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toMatch(/error TS(?:2322|2345|2722)/);
    }
  });
}
