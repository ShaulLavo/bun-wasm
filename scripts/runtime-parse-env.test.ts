import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-parse-env-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const output = join(scratch, "util.js");
const stripped = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js/util.ts"), output]);
if (stripped.exitCode !== 0) throw new Error(stripped.stderr.toString());
const factory: unknown = runInNewContext(readFileSync(output, "utf8"), { TypeError });
if (typeof factory !== "function") throw new TypeError("Expected utility factory");
const inputs: string[] = [];
const result = { VALUE: "literal $OTHER" };
const util: unknown = factory({ native: { parseEnv(content: string) { inputs.push(content); return Object.entries(result); } } });
if (!util || typeof util !== "object") throw new TypeError("Expected utility module");
const utility = util;

function parseEnv(content: unknown): unknown {
  const parse: unknown = Reflect.get(utility, "parseEnv");
  if (typeof parse !== "function") throw new TypeError("Missing node:util parseEnv export");
  return parse(content);
}

test("node:util exposes parseEnv and delegates strings unchanged to the native parser", () => {
  const content = 'VALUE="literal $OTHER"\r\n';
  expect(parseEnv(content)).toEqual(result);
  expect(inputs).toEqual([content]);
});

test.each([undefined, null, 1, true, {}, new String("A=1")])("parseEnv rejects non-string content %p before entering native code", content => {
  const previous = inputs.length;
  expect(() => parseEnv(content)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(inputs.length).toBe(previous);
});

test("parseEnv constructs own data properties for prototype-like keys", () => {
  if (typeof factory !== "function") throw new TypeError("Expected utility factory");
  const module: unknown = factory({ native: { parseEnv: () => [["__proto__", "safe"], ["constructor", "value"]] } });
  if (!module || typeof module !== "object") throw new TypeError("Expected utility module");
  const parse: unknown = Reflect.get(module, "parseEnv");
  if (typeof parse !== "function") throw new TypeError("Missing parseEnv export");
  const actual = parse("__proto__=safe\nconstructor=value");
  expect(Object.hasOwn(actual, "__proto__")).toBe(true);
  expect(actual.__proto__).toBe("safe");
  expect(actual.constructor).toBe("value");
});

test("the browser's generic builtin wrapper links Vite's published node:util import", async () => {
  const host = readFileSync(join(root, "web/src/engine-host.js"), "utf8");
  const start = host.indexOf("function wrapperSource(key, value) {");
  if (start < 0) throw new Error("Missing browser builtin wrapper");
  const wrapper: unknown = runInNewContext(`(${host.slice(start)})`);
  if (typeof wrapper !== "function") throw new TypeError("Expected browser builtin wrapper");
  const source = wrapper("node:util", utility);
  const builtin = `data:text/javascript,${encodeURIComponent(source)}`;
  const published = `import { format, formatWithOptions, inspect, isDeepStrictEqual, parseEnv, promisify, stripVTControlCharacters } from ${JSON.stringify(builtin)};
export const loaded = [format, formatWithOptions, inspect, isDeepStrictEqual, parseEnv, promisify, stripVTControlCharacters].every(value => typeof value === "function");`;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "__bunwasm_wrap");
  Object.defineProperty(globalThis, "__bunwasm_wrap", { configurable: true, value: () => ({ value: utility, default: utility }) });
  try {
    expect((await import(`data:text/javascript,${encodeURIComponent(published)}`)).loaded).toBe(true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "__bunwasm_wrap", previous);
    else Reflect.deleteProperty(globalThis, "__bunwasm_wrap");
  }
});
