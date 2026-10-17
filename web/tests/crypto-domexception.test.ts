import {test, expect} from "bun:test";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {webcrypto} from "node:crypto";
test("host crypto errors retain the DOMException brand", async () => {
  const streams = (0, eval)(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/streams.js", import.meta.url), "utf8"));
  const native = {engine: "host", DOMException, timeOrigin: () => 0, platformInfo: {version: "test", arch: "wasm"}};
  // /work/tmp is this repository's local scratch preference; CI runners lack it.
  const root = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = mkdtempSync(join(root, "bun-wasm-compression-crypto-"));
  let compression;
  try {
    const output = join(scratch, "compression.js");
    const compiled = Bun.spawnSync(["node", "--no-warnings", fileURLToPath(new URL("../../scripts/transpile-runtime.ts", import.meta.url)),
      fileURLToPath(new URL("../../crates/bunwasm-runtime/src/js/compression_streams.ts", import.meta.url)), output]);
    expect(compiled.exitCode).toBe(0);
    compression = (0, eval)(readFileSync(output, "utf8"))({native});
  } finally { rmSync(scratch, {recursive: true, force: true}); }
  const streamExports = streams({native, require(name: string) { expect(name).toBe("compression_streams"); return compression; }});
  const internal = {require(name: string) { expect(name).toBe("streams"); return streamExports; }, native};
  const factory = (0, eval)(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/web.js", import.meta.url),"utf8"));
  factory(internal);
  let error;
  try { await webcrypto.subtle.importKey("raw",new Uint8Array(1),"AES-GCM",false,["encrypt"]); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DOMException);
  expect(error).toBeInstanceOf(internal.DOMException);
});
