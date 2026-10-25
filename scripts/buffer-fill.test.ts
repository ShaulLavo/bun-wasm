import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/buffer.js", import.meta.url), "utf8");
function emittedFillArgs() {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-buffer-fill-"));
  try {
    const output = join(scratch, "buffer_fill_args.js");
    const emitted = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL("../crates/bunwasm-runtime/src/js/buffer_fill_args.ts", import.meta.url).pathname, output]);
    expect(emitted.exitCode).toBe(0);
    return runInNewContext(readFileSync(output, "utf8"))();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const fillArgs = emittedFillArgs();
const { Buffer: GuestBuffer } = runInNewContext(source, { TextEncoder, TextDecoder })({
  require(module: string) {
    if (module === "buffer_fill_args") return fillArgs;
    throw new Error(`Unexpected module ${module}`);
  },
});

test("Buffer.fill accepts encoding after a numeric start", () => {
  const bytes = GuestBuffer.alloc(5, ".");
  expect(bytes.fill("é", 1, "latin1")).toBe(bytes);
  expect(bytes.toString("hex")).toBe("2ee9e9e9e9");
  expect(GuestBuffer.alloc(5, ".").fill("6162", 1, "hex").toString("hex")).toBe("2e61626162");
});

test("Buffer.fill retains its other range and encoding overloads", () => {
  expect(GuestBuffer.alloc(5, ".").fill("6162", "hex").toString("hex")).toBe("6162616261");
  expect(GuestBuffer.alloc(5, ".").fill("6162", 1, 3, "hex").toString("hex")).toBe("2e61622e2e");
  expect(GuestBuffer.alloc(5, ".").fill("é", 1, 4, "latin1").toString("hex")).toBe("2ee9e9e92e");
});

test("Buffer.fill validates the selected encoding", () => {
  expect(() => GuestBuffer.alloc(5).fill("x", 1, "not-an-encoding"))
    .toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_UNKNOWN_ENCODING" }));
});

test("Buffer.fill does not treat a non-string fill value as an encoding overload", () => {
  expect(() => GuestBuffer.alloc(5).fill(1, 1, "hex"))
    .toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" }));
  expect(GuestBuffer.alloc(5, ".").fill("6162", 1, "hex", "latin1").toString("hex")).toBe("2e61626162");
});

test("Buffer.fill validates an encoding even when start reaches or passes the buffer end", () => {
  for (const start of [5, 6]) {
    expect(() => GuestBuffer.alloc(5, ".").fill("x", start, "not-an-encoding"))
      .toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_UNKNOWN_ENCODING" }));
  }
});

test("Buffer.fill with a valid encoding preserves an empty range", () => {
  for (const start of [5, 6]) {
    const bytes = GuestBuffer.alloc(5, ".");
    expect(bytes.fill("é", start, "latin1")).toBe(bytes);
    expect(bytes.toString("hex")).toBe("2e2e2e2e2e");
  }
});

test("Buffer.fill with undefined start uses default encoding instead of its third argument", () => {
  expect(GuestBuffer.alloc(5, ".").fill("é", undefined, "latin1").toString("hex")).toBe("c3a9c3a9c3");
  expect(GuestBuffer.alloc(5, ".").fill("é", undefined, "not-an-encoding").toString("hex")).toBe("c3a9c3a9c3");
  expect(GuestBuffer.alloc(5, ".").fill("x").toString("hex")).toBe("7878787878");
});
