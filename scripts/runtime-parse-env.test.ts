import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the browser's generic builtin wrapper links Vite's published node:util import", () => {
  const host = readFileSync(join(root, "web/src/engine-host.js"), "utf8");
  const start = host.indexOf("function wrapperSource(key, value) {");
  if (start < 0) throw new Error("Missing browser builtin wrapper");
  const probe = join(scratch, "published-import.ts");
  writeFileSync(probe, `
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const utility = runInNewContext(readFileSync(${JSON.stringify(output)}, "utf8"))({ native: {} });
const wrapper = runInNewContext(${JSON.stringify(`(${host.slice(start)})`)});
Reflect.set(globalThis, "__bunwasm_wrap", () => ({ value: utility, default: utility }));
const builtin = "data:text/javascript," + encodeURIComponent(wrapper("node:util", utility));
const published = 'import { format, formatWithOptions, inspect, isDeepStrictEqual, parseEnv, promisify, stripVTControlCharacters } from ' + JSON.stringify(builtin) + '; export const loaded = [format, formatWithOptions, inspect, isDeepStrictEqual, parseEnv, promisify, stripVTControlCharacters].every(value => typeof value === "function");';
console.log((await import("data:text/javascript," + encodeURIComponent(published))).loaded);
`);
  const loaded = Bun.spawnSync(["node", "--no-warnings", probe], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(loaded.exitCode, loaded.stderr.toString()).toBe(0);
  expect(loaded.stdout.toString()).toBe("true\n");
});
