import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

test("host crypto errors retain the DOMException brand", async () => {
  const source = (name: string) => readFileSync(new URL(`../../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  const native = { engine: "host", DOMException, timeOrigin: () => 0, platformInfo: { version: "test", arch: "wasm" } };
  const streams = (0, eval)(source("streams.js"));
  const root = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = mkdtempSync(join(root, "bun-wasm-crypto-brand-"));
  let compression;
  try {
    const output = join(scratch, "compression.js");
    const compiled = Bun.spawnSync([
      "node", "--no-warnings", fileURLToPath(new URL("../../scripts/transpile-runtime.ts", import.meta.url)),
      fileURLToPath(new URL("../../crates/bunwasm-runtime/src/js/compression_streams.ts", import.meta.url)), output,
    ]);
    expect(compiled.exitCode).toBe(0);
    compression = (0, eval)(readFileSync(output, "utf8"))({ native });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const webBrand = (0, eval)(source("web_brand.ts"))();
  const modules = new Map<string, () => unknown>([
    ["compression_streams", () => compression],
    ["web_brand", () => webBrand],
  ]);
  const streamExports = streams({ native, require(name: string) {
    expect(name).toBe("compression_streams");
    return modules.get(name)!();
  } });
  const internal: {
    require(name: string): unknown;
    native: typeof native;
    DOMException?: typeof DOMException;
  } = {
    require(name) {
      if (name === "streams") return streamExports;
      const load = modules.get(name);
      if (!load) throw new Error(`Unexpected runtime factory ${name}`);
      return load();
    },
    native,
  };
  (0, eval)(source("web.js"))(internal);
  let error: unknown;
  try {
    await webcrypto.subtle.importKey("raw", new Uint8Array(1), "AES-GCM", false, ["encrypt"]);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DOMException);
  expect(error).toBeInstanceOf(internal.DOMException);
});
