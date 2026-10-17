import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

function brandFactory() {
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync("/work/tmp/bun-wasm-crypto-brand-");
    const output = join(scratch, "web-brand.js");
    const compiled = Bun.spawnSync([
      "node", new URL("../../scripts/transpile-runtime.ts", import.meta.url).pathname,
      new URL("../../crates/bunwasm-runtime/src/js/web_brand.ts", import.meta.url).pathname, output,
    ]);
    expect(compiled.exitCode).toBe(0);
    return (0, eval)(readFileSync(output, "utf8"));
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

test("host crypto errors retain the DOMException brand", async () => {
  const source = (name: string) => readFileSync(new URL(`../../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  const streams = (0, eval)(source("streams.js"));
  const webBrand = brandFactory();
  const modules = new Map<string, () => unknown>([
    ["streams", () => streams({ native: { engine: "host" } })],
    ["web_brand", () => webBrand()],
  ]);
  const internal: {
    require(name: string): unknown;
    native: { DOMException: typeof DOMException; timeOrigin(): number; platformInfo: { version: string; arch: string } };
    DOMException?: typeof DOMException;
  } = {
    require(name) {
      const load = modules.get(name);
      if (!load) throw new Error(`Unexpected runtime factory ${name}`);
      return load();
    },
    native: { DOMException, timeOrigin: () => 0, platformInfo: { version: "test", arch: "wasm" } },
  };
  (0, eval)(source("web.js"))(internal);
  let error: unknown;
  try {
    await webcrypto.subtle.importKey("raw", new Uint8Array(1), "AES-GCM", false, ["encrypt"]);
  } catch (caught) {
    error = caught;
  }
  if (!internal.DOMException) throw new Error("Web factory did not install DOMException");
  expect(error).toBeInstanceOf(DOMException);
  expect(error).toBeInstanceOf(internal.DOMException);
});
