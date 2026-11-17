import { test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { boundaryChecks } from "../tests/fixtures/buffer-allocation-boundaries/checks.ts";
import { loadBufferSource } from "./buffer-source.ts";

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
}

function loadConcat() {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-concat-source-"));
  try {
    const output = join(scratch, "concat.js");
    const result = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL("../crates/bunwasm-runtime/src/js/concat_array_buffers.ts", import.meta.url).pathname, output]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const factory = runInNewContext(readFileSync(output, "utf8"), { Uint8Array, TypeError, RangeError });
    const concat: typeof Bun.concatArrayBuffers = factory({ toUint8 });
    return concat;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const source = loadBufferSource();
for (const check of boundaryChecks(source.Buffer, source, loadConcat())) test(check.name, check.run);
