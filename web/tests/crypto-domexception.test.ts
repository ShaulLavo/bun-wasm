import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

test("host crypto errors retain the DOMException brand", async () => {
  const source = (name: string) => readFileSync(new URL(`../../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  const native = { engine: "host", DOMException, timeOrigin: () => 0, platformInfo: { version: "test", arch: "wasm" } };
  const root = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = mkdtempSync(join(root, "bun-wasm-crypto-brand-"));
  try {
    const compile = (name: string) => {
      const output = join(scratch, `${name}.js`);
      const compiled = Bun.spawnSync([
        "node", "--no-warnings", fileURLToPath(new URL("../../scripts/transpile-runtime.ts", import.meta.url)),
        fileURLToPath(new URL(`../../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url)), output,
      ]);
      expect(compiled.exitCode).toBe(0);
      // oxlint-disable-next-line no-eval -- execute the actual classic-script polyfill factory
      return (0, eval)(readFileSync(output, "utf8"));
    };
    const streams = compile("streams");
    const compression = compile("compression_streams")({ native });
    const webBrand = compile("web_brand")();
    const bodyStreams = compile("body_streams")();
    const modules = new Map<string, () => unknown>([
      ["compression_streams", () => compression],
      ["web_brand", () => webBrand],
      ["body_streams", () => bodyStreams],
      ["url_search_params", () => compile("url_search_params")()],
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
    // oxlint-disable-next-line no-eval -- execute the actual classic-script polyfill factory
    (0, eval)(source("web.js"))(internal);
    let error: unknown;
    try {
      await webcrypto.subtle.importKey("raw", new Uint8Array(1), "AES-GCM", false, ["encrypt"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toBeInstanceOf(internal.DOMException);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return;
});
