import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-url-parity-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const output = join(scratch, "node_url.js");
const emitted = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js/node_url.ts"), output]);
if (emitted.exitCode !== 0) throw new Error(emitted.stderr.toString());
const calls: string[] = [];
interface UrlAdapter {
  fileURLToPath(input: unknown): string;
  format(input: object): string;
  domainToUnicode(input: unknown): string;
}
const adapter: UrlAdapter = runInNewContext(readFileSync(output, "utf8"), { URL, URLSearchParams, TypeError })({
  native: { domainToUnicode(domain: string) { calls.push(domain); return "native result"; } },
  web: { URLSearchParams },
  describe: (input: unknown) => `type ${typeof input} (${String(input)})`,
});

test("emitted fileURLToPath reports the url argument and preserves valid URLs", () => {
  expect(() => adapter.fileURLToPath(7)).toThrow('The "url" argument must be of type string. Received type number (7)');
  expect(adapter.fileURLToPath(new URL("file:///caf%C3%A9"))).toBe("/café");
  expect(() => adapter.fileURLToPath("not a URL")).toThrow("The URL must be of scheme file");
});

test("emitted format uses URLSearchParams record and sequence semantics", () => {
  expect(adapter.format({ query: { a: "1", b: ["2", "3"], space: "a b~!" } })).toBe("?a=1&b=2%2C3&space=a+b%7E%21");
  expect(adapter.format({ query: [["a", "1"], ["a", "2"]] })).toBe("?a=1&a=2");
  expect(adapter.format({ query: { n: null, u: undefined, b: false } })).toBe("?n=null&u=undefined&b=false");
  expect(adapter.format({ query: new URLSearchParams("a=1") })).toBe("");
  expect(adapter.format({ query: "a=1" })).toBe("");
  expect(adapter.format({ query: { a: [1, 2] }, search: "?fixed" })).toBe("?fixed");
});

test("emitted domainToUnicode coerces once and calls the authoritative native", () => {
  let coerced = 0;
  expect(adapter.domainToUnicode({ toString() { coerced++; return "xn--bcher-kva.de"; } })).toBe("native result");
  expect(coerced).toBe(1);
  expect(calls).toEqual(["xn--bcher-kva.de"]);
});

test("native decoder and runtime URLSearchParams declarations accept and reject their inputs", () => {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
    files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), probe],
  }));
  const sources = [
    ['const decoded: string = internal.native.domainToUnicode("xn--bcher-kva.de"); new internal.web.URLSearchParams({ nil: null, list: [1, 2] }).toString();', true],
    ["internal.native.domainToUnicode(7);", false],
    ['const wrong: number = internal.native.domainToUnicode("a");', false],
    ["new internal.web.URLSearchParams(7);", false],
  ] as const;
  for (const [source, valid] of sources) {
    writeFileSync(probe, 'declare const internal: BunWasm.Internal;\n' + source);
    const result = Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
    expect(result.exitCode === 0).toBe(valid);
    if (!valid) expect(result.stdout.toString()).toContain("error TS");
  }
});
