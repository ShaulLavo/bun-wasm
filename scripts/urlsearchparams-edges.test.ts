import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-url-edges-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function emitted(path: string) {
  const output = join(scratch, "emitted.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), path, output]);
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

test("shared URLSearchParams and node:url match the native edge fixture", () => {
  const lines: string[] = [];
  const context = { Error, TypeError, RangeError, URIError, console: { log: (...items: unknown[]) => lines.push(items.map(String).join(" ")) } };
  const internal = {
    native: { timeOrigin: () => 0, platformInfo: { version: "test", arch: "test" } },
    require: (name: string): unknown => {
      if (name === "web_brand") return () => {};
      const source = join(root, `crates/bunwasm-runtime/src/js/${name}.ts`);
      if (name === "url_search_params") return runInNewContext(emitted(source), context)();
      return {};
    },
    describe: (input: object) => `an instance of ${input.constructor.name}`,
    web: { URL, URLSearchParams },
  };
  runInNewContext(readFileSync(join(root, "crates/bunwasm-runtime/src/js/web.js"), "utf8"), context)(internal);
  const globals = { ...context, URL: internal.web.URL, URLSearchParams: internal.web.URLSearchParams };
  const adapter = runInNewContext(emitted(join(root, "crates/bunwasm-runtime/src/js/node_url.ts")), globals)(internal);
  const fixture = emitted(join(root, "tests/fixtures/runtime-urlsearchparams-edges/index.ts")).replace('import * as url from "node:url";', "const url = adapter;");
  runInNewContext(fixture, { ...globals, adapter });
  expect(lines.join("\n") + "\n").toBe(readFileSync(join(root, "tests/fixtures/runtime-urlsearchparams-edges/expected.txt"), "utf8"));
});
