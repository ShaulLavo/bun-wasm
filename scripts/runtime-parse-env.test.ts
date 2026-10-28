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
const util: unknown = factory({ native: { parseEnv(content: string) { inputs.push(content); return result; } } });
if (!util || typeof util !== "object") throw new TypeError("Expected utility module");

function parseEnv(content: unknown): unknown {
  const parse: unknown = Reflect.get(util, "parseEnv");
  if (typeof parse !== "function") throw new TypeError("Missing node:util parseEnv export");
  return parse(content);
}

test("node:util exposes parseEnv and delegates strings unchanged to the native parser", () => {
  const content = 'VALUE="literal $OTHER"\r\n';
  expect(parseEnv(content)).toBe(result);
  expect(inputs).toEqual([content]);
});

test.each([undefined, null, 1, true, {}, new String("A=1")])("parseEnv rejects non-string content %p before entering native code", content => {
  const previous = inputs.length;
  expect(() => parseEnv(content)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(inputs.length).toBe(previous);
});
