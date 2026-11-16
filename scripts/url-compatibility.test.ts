import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { domainToASCII, domainToUnicode } from "node:url";
import { createContext, runInContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-url-compat-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const directory = join(root, "crates/bunwasm-runtime/src/js");

function emitted(path: string) {
  const output = join(scratch, "emitted.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), path, output]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return readFileSync(output, "utf8");
}

function sourceRuntime() {
  const realm = createContext({ TypeError, Error, RangeError, ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, assert });
  const modules = new Map<string, unknown>();
  const lines: string[] = [];
  const internal = {
    native: {
      timeOrigin: () => 0,
      platformInfo: { version: "test", arch: "test" },
      utf8Encode: (input: string) => new TextEncoder().encode(input),
      randomBytes,
      domainToASCII,
      domainToUnicode,
      urlParse(input: string, base?: string) {
        const url = URL.parse(input, base);
        if (!url) return undefined;
        return [url.href, url.protocol, url.username, url.password, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin];
      },
    },
    web: { URL, URLSearchParams, Blob, File },
    require(name: string): unknown {
      if (name === "text_decoder") return TextDecoder;
      if (name === "streams" || name === "body_streams") return {};
      if (modules.has(name)) return modules.get(name);
      const typed = join(directory, `${name}.ts`);
      const source = existsSync(typed) ? emitted(typed) : readFileSync(join(directory, `${name}.js`), "utf8");
      const module: unknown = runInContext(source, realm)(internal);
      modules.set(name, module);
      return module;
    },
  };
  const install = runInContext(readFileSync(join(directory, "web.js"), "utf8"), realm)(internal);
  install((name: string, value: unknown) => { realm[name] = value; }, () => {});
  realm.console = { log: (line: string) => lines.push(line) };
  realm.adapter = internal.require("node_url");
  realm.buffer = internal.require("buffer");
  return { realm, lines };
}

test("production URL and buffer factories satisfy the native Bun URL contract", async () => {
  const { realm, lines } = sourceRuntime();
  const fixture = emitted(join(root, "tests/fixtures/url-compatibility/index.ts"))
    .replace('import assert from "node:assert/strict";', "")
    .replace('import { parse, urlToHttpOptions } from "node:url";', "const { parse, urlToHttpOptions } = adapter;")
    .replace('import buffer, { resolveObjectURL } from "node:buffer";', "const { resolveObjectURL } = buffer;");
  await runInContext(fixture, realm);
  expect(lines).toEqual(["URL compatibility ok"]);
});

test("resolved Blobs cannot mutate the registry or the creating Blob", async () => {
  const { realm } = sourceRuntime();
  const result: string[] = await runInContext(`(async () => {
    const original = new Blob(["hello"]);
    const url = URL.createObjectURL(original);
    const resolved = buffer.resolveObjectURL(url);
    resolved._bytes()[0] = 0;
    const result = [await original.text(), await buffer.resolveObjectURL(url).text()];
    URL.revokeObjectURL(url);
    return result;
  })()`, realm);
  expect(Array.from(result)).toEqual(["hello", "hello"]);
});
