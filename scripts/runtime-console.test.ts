import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";
import { runtimeSyntax } from "./runtime-syntax";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-console-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const originals: Record<string, string> = {
  console: "ebeea9ed77c8d2a5b8bc6edb94536023c2e329a74b6b84a7500075b4582fc325",
  console_constructor: "d70e5d7de10633d8dc36e2a623d3f6253c9bcc7f785db581152bcf345beebbbf",
};

function emitted(name: string): { text: string; source: string } {
  const path = join(root, `crates/bunwasm-runtime/src/js/${name}`);
  const output = join(scratch, `${name}.js`);
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), `${path}.ts`, output]);
  expect(result.exitCode).toBe(0);
  return { text: readFileSync(output, "utf8"), source: readFileSync(`${path}.ts`, "utf8") };
}

for (const [name, hash] of Object.entries(originals)) {
  test(`${name} preserves the approved executable AST and strict directive`, () => {
    expect(new Bun.CryptoHasher("sha256").update(runtimeSyntax(emitted(name).text)).digest("hex")).toBe(hash);
  });
  test(`${name} preserves every emitted token's TypeScript line and column`, () => {
    const output = emitted(name);
    const lines = output.source.split("\n");
    expect(output.text.split("\n").length).toBe(lines.length);
    const file = ts.createSourceFile("runtime.js", output.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node): void {
      const children = node.getChildren(file);
      if (children.length) { children.forEach(visit); return; }
      const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
      const token = node.getText(file);
      expect(lines.slice(line).join("\n").slice(character, character + token.length)).toBe(token);
    }
    visit(file);
  });
}

interface TraceTarget { name: string; message: string; stack?: unknown }
interface Intrinsics {
  require(name: string): { validateObject(value: unknown, name: string): void; validateInteger(value: unknown, name: string, min: number, max: number): void; validateArray(value: unknown, name: string): void; validateOneOf(value: unknown, name: string, choices: unknown[]): void };
  captureStackTrace(target: TraceTarget, skip?: (...args: never[]) => unknown): void;
  isMap(value: unknown): boolean;
  isSet(value: unknown): boolean;
  newCppFunction(file: string, name: string): (text: string, strip?: boolean) => number;
}

function intrinsics(ErrorClass: new(message?: string) => Error = Error): Intrinsics {
  const factory: (internal: object) => Intrinsics = runInNewContext(emitted("console_constructor").text, {
    Error: ErrorClass, TypeError, RangeError, Bun: { stringWidth: (text: string) => text.length },
  }, { filename: "bun-wasm:console_constructor" });
  return factory({ builtin: () => ({}), defaultPrepareStackTrace: undefined });
}

test("constructor validators retain native error identity and codes", () => {
  const validators = intrinsics().require("internal/validators");
  const cases: [() => void, ErrorConstructor, string][] = [
    [() => validators.validateObject(null, "options"), TypeError, "ERR_INVALID_ARG_TYPE"],
    [() => validators.validateObject([], "options"), TypeError, "ERR_INVALID_ARG_TYPE"],
    [() => validators.validateInteger("2", "indent", 0, 1000), TypeError, "ERR_INVALID_ARG_TYPE"],
    [() => validators.validateInteger(0.5, "indent", 0, 1000), RangeError, "ERR_OUT_OF_RANGE"],
    [() => validators.validateArray({}, "columns"), TypeError, "ERR_INVALID_ARG_TYPE"],
    [() => validators.validateOneOf("bad", "mode", [true, false, "auto"]), TypeError, "ERR_INVALID_ARG_VALUE"],
  ];
  for (const [trigger, Ctor, code] of cases) {
    let caught: unknown;
    try { trigger(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Ctor);
    if (!(caught instanceof Error)) throw new Error("Expected original error constructor");
    expect(Object.getPrototypeOf(caught)).toBe(Ctor.prototype);
    expect(Object.getOwnPropertyDescriptor(caught, "code")?.value).toBe(code);
    expect(caught.stack).toContain("bun-wasm:console_constructor");
  }
});

test("constructor captures brands, native stack hooks and unsupported native errors", () => {
  const adapter = intrinsics();
  expect(adapter.isMap(new Map())).toBe(true);
  expect(adapter.isMap(new Proxy(new Map(), {}))).toBe(false);
  expect(adapter.isSet(new Set())).toBe(true);
  expect(adapter.isSet(Object.create(Set.prototype))).toBe(false);
  expect(adapter.newCppFunction("stringWidth.cpp", "jsFunctionBunStringWidth")("abc")).toBe(3);
  expect(() => adapter.newCppFunction("missing", "name")).toThrow("Unsupported Console native missing:name");
  const calls: unknown[][] = [];
  class NativeError extends Error {
    static captureStackTrace(target: TraceTarget, skip?: (...args: never[]) => unknown) { calls.push([target, skip]); target.stack = "Error\n    at original"; }
  }
  Object.defineProperty(NativeError, "prepareStackTrace", { value: undefined });
  const target = { name: "Trace", message: "message" };
  intrinsics(NativeError).captureStackTrace(target, test);
  expect(calls).toEqual([[target, test]]);
  expect(Object.getOwnPropertyDescriptor(target, "stack")).toEqual({ value: "Trace: message\n    at original", writable: true, configurable: true, enumerable: true });
});

test("global console keeps formatter inputs, duration state and byte writes", () => {
  const writes: (string | Uint8Array)[] = [];
  const formatted: unknown[][] = [];
  let now = 10;
  const factory: (internal: object) => Omit<Console, "write"> & { write(...args: unknown[]): void } = runInNewContext(emitted("console").text, {
    process: { stdout: {}, stderr: {} },
  });
  const instance = factory({
    native: { writeStdout: (text: string | Uint8Array) => writes.push(text), writeStderr: (text: string) => writes.push(text), now: () => now },
    require: () => ({
      formatArgs(args: unknown[]) { formatted.push(args); return args.map(String).join(" "); },
      bunInspect: (value: unknown) => JSON.stringify(value),
    }),
    toUint8(value: unknown) {
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
    },
  });
  instance.group("outer");
  instance.log("a\nb");
  instance.groupEnd();
  instance.assert(false, "reason", 7);
  instance.time("timer");
  now = 1010;
  instance.timeLog("timer", "extra");
  instance.timeEnd("timer");
  instance.timeEnd("timer");
  instance.write("raw", new DataView(Uint8Array.of(1, 2, 3).buffer, 1, 1));
  expect(writes.slice(0, 5)).toEqual(["outer\n", "  a\n  b\n", "Assertion failed: reason 7\n", "[1.00s] timer extra\n", "[1.00s] timer\n"]);
  expect(formatted.at(-2)).toEqual(["[1.00s] timer", "extra"]);
  expect(writes[5]).toBe("raw");
  expect(Array.from(writes[6] instanceof Uint8Array ? writes[6] : [])).toEqual([2]);
  expect(() => instance.write({})).toThrow("Expected an ArrayBuffer or ArrayBufferView");
});

function checkContract(source: string) {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(probe, 'declare const internal: BunWasm.Internal;\nconst adapter = internal.require("console_constructor");\n' + source);
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
    files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), join(root, "crates/bunwasm-runtime/src/js/console_types.d.ts"), probe],
  }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("console contracts accept native bytes, format arguments and typed intrinsic calls", () => {
  const result = checkContract(`
    internal.native.writeStdout("text", true);
    internal.native.writeStderr(new Uint8Array());
    internal.require("inspect").formatArgs(["value", 1]);
    internal.require("inspect").bunInspect({}, { depth: 0, compact: true });
    const size: number = adapter.call(function(this: string, count: number) { return this.length + count; }, "text", 2);
    const value: number | undefined = adapter.get(new Map<string, number>(), "key");
    const rows: string[] = adapter.newArrayWithSize<string>(2);
  `);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

for (const source of [
  'internal.native.writeStdout(1);',
  'internal.native.writeStdout("text", "true");',
  'internal.native.writeStderr(new Uint16Array());',
  'internal.require("inspect").formatArgs("not an array");',
  'internal.require("inspect").bunInspect({}, { compact: "true" });',
  'adapter.call(function(this: string, count: number) { return this.length + count; }, "text", "two");',
  'adapter.get(new Map<string, number>(), 1);',
  'const value: number = adapter.newCppFunction("stringWidth.cpp", "jsFunctionBunStringWidth")("text", "false");',
]) {
  test(`console contracts reject ${source}`, () => {
    const result = checkContract(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
