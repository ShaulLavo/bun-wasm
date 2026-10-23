import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";

type Formats = { YAML: { parse(input: unknown): unknown } };
const source = join(import.meta.dir, "../crates/bunwasm-runtime/src/js");

function formats() {
  let parsed = 0;
  const native = {
    parseData() { parsed++; return '{"root":[0,"parsed"],"nodes":[]}'; },
    utf8Encode(value: string) { return new TextEncoder().encode(value); },
  };
  const internal = {
    native,
    toUint8(input: ArrayBuffer | ArrayBufferView) {
      if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return new Uint8Array(input);
    },
    require(name: string): unknown {
      const path = join(source, `${name}.ts`);
      const text = readFileSync(existsSync(path) ? path : join(source, `${name}.js`), "utf8");
      const factory = runInThisContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${text}`));
      return factory(internal);
    },
  };
  const factory: (internal: object) => Formats = runInThisContext(readFileSync(join(source, "formats.js"), "utf8"));
  return { YAML: factory(internal).YAML, parsed: () => parsed };
}

function failure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected the input limit to reject the value");
}

test("YAML rejects oversized bytes before parsing with the Bun range error", () => {
  const { YAML, parsed } = formats();
  const input = new Uint8Array(2 ** 31 + 2);
  const error = failure(() => YAML.parse(input));
  expect(error).toBeInstanceOf(RangeError);
  expect(error).toMatchObject({
    code: "ERR_OUT_OF_RANGE",
    message: 'The value of "input.byteLength" is out of range. It must be <= 2147483647. Received 2147483650',
  });
  expect(parsed()).toBe(0);
});

test("YAML checks the view length rather than its backing buffer length", () => {
  const { YAML, parsed } = formats();
  const buffer = new ArrayBuffer(2 ** 31 + 2);
  expect(YAML.parse(new DataView(buffer, buffer.byteLength - 4, 4))).toBe("parsed");
  expect(parsed()).toBe(1);
});

test("YAML accepts the inclusive signed 32-bit size limit", () => {
  const { YAML, parsed } = formats();
  expect(YAML.parse(new Uint8Array(0x7fffffff))).toBe("parsed");
  expect(parsed()).toBe(1);
});
