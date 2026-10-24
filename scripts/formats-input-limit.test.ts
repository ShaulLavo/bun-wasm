import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

type SizeInput = { readonly byteLength: number };
type SizeGuard = { checkSize(input: SizeInput): void };
type Format = "JSON" | "JSONC" | "JSON5" | "TOML" | "YAML";
type ParsedCall = { bytes: Uint8Array; format: Format };
type FormatInternal = {
  native: { parseData(bytes: Uint8Array, format: Format): string; utf8Encode(value: string): Uint8Array };
  toUint8(input: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array;
  require(name: "formats_limit"): SizeGuard;
  require(name: "yaml_coercion"): (value: unknown) => unknown;
};
type Formats = { parse(input: unknown, format: Format): unknown };

const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? tmpdir(), "bun-wasm-format-limit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function source(name: string) {
  const output = join(scratch, `${name}.js`);
  const result = Bun.spawnSync(["node", fileURLToPath(new URL("./transpile-runtime.ts", import.meta.url)),
    fileURLToPath(new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url)), output], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return readFileSync(output, "utf8");
}

function sizeGuard(): SizeGuard {
  const factory: () => SizeGuard = runInNewContext(source("formats_limit"), { RangeError });
  return factory();
}

function requireHelper(name: "formats_limit"): SizeGuard;
function requireHelper(name: "yaml_coercion"): (value: unknown) => unknown;
function requireHelper(name: string) {
  if (name === "formats_limit") return sizeGuard();
  if (name === "yaml_coercion") return (value: unknown) => value;
  throw new Error(`Unexpected helper ${name}`);
}

function formats(encoded?: Uint8Array, nativeError?: Error) {
  const calls: ParsedCall[] = [];
  const internal = {
    native: {
      parseData(bytes: Uint8Array, format: Format) {
        if (nativeError) throw nativeError;
        calls.push({ bytes, format });
        return '{"root":[0,"parsed"],"nodes":[]}';
      },
      utf8Encode(value: string) { return encoded ?? new TextEncoder().encode(value); },
    },
    toUint8(input: ArrayBuffer | SharedArrayBuffer | ArrayBufferView) {
      if (input instanceof Uint8Array) return input;
      if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return new Uint8Array(input);
    },
    require: requireHelper,
  };
  const factory: (internal: FormatInternal) => Formats = runInNewContext(source("formats"), {
    ArrayBuffer, SharedArrayBuffer, Blob, RangeError,
  });
  return { adapter: factory(internal), calls };
}

function failure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected the input limit to reject the value");
}

test("converted synthetic length rejects before parsing with the Bun error data", () => {
  const bytes = Object.defineProperty(new Uint8Array(0), "byteLength", { value: 2 ** 31 });
  const { adapter, calls } = formats(bytes);
  const error = failure(() => adapter.parse("small input", "YAML"));
  expect(error).toBeInstanceOf(RangeError);
  expect(Object.getPrototypeOf(error)).toBe(RangeError.prototype);
  expect(error).toMatchObject({
    name: "RangeError",
    code: "ERR_OUT_OF_RANGE",
    message: 'The value of "input.byteLength" is out of range. It must be <= 2147483647. Received 2147483648',
  });
  expect(calls).toEqual([]);
});

test("size guard snapshots an accessor before formatting the coded error", () => {
  let reads = 0;
  const input: SizeInput = {
    get byteLength() {
      reads += 1;
      return reads === 1 ? 2 ** 31 : 0;
    },
  };
  const error = failure(() => sizeGuard().checkSize(input));
  expect(reads).toBe(1);
  expect(error).toMatchObject({
    code: "ERR_OUT_OF_RANGE",
    message: 'The value of "input.byteLength" is out of range. It must be <= 2147483647. Received 2147483648',
  });
});

test("size-only seam accepts zero and the inclusive signed 32-bit limit without allocating bytes", () => {
  const { checkSize } = sizeGuard();
  expect(checkSize({ byteLength: 0 })).toBeUndefined();
  expect(checkSize({ byteLength: 2 ** 31 - 1 })).toBeUndefined();
  expect(() => checkSize({ byteLength: 2 ** 31 })).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  expect(() => checkSize({ byteLength: 2 ** 31 + 2 })).toThrow(expect.objectContaining({
    code: "ERR_OUT_OF_RANGE",
    message: 'The value of "input.byteLength" is out of range. It must be <= 2147483647. Received 2147483650',
  }));
});

test("small typed views keep their original buffer, offset, byte count and format", () => {
  const buffer = new ArrayBuffer(32);
  const views = [new Uint8Array(buffer, 7, 3), new Uint16Array(buffer, 8, 2), new DataView(buffer, 19, 5)];
  const { adapter, calls } = formats();
  for (const view of views) expect(adapter.parse(view, "YAML")).toBe("parsed");
  expect(calls).toHaveLength(views.length);
  for (const [index, view] of views.entries()) {
    const call = calls[index];
    if (!call) throw new Error("Missing native-call record");
    expect(call.format).toBe("YAML");
    expect(call.bytes.buffer).toBe(buffer);
    expect(call.bytes.byteOffset).toBe(view.byteOffset);
    expect(call.bytes.byteLength).toBe(view.byteLength);
  }
});

test("guard leaves small text conversion and native error identity unchanged", () => {
  const { adapter, calls } = formats();
  expect(adapter.parse("é", "YAML")).toBe("parsed");
  expect(calls.map(call => Array.from(call.bytes))).toEqual([[0xc3, 0xa9]]);
  const sentinel = new Error("native parse");
  expect(failure(() => formats(undefined, sentinel).adapter.parse("", "YAML"))).toBe(sentinel);
});
