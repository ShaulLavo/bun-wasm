import { describe, expect, test } from "bun:test";
import { readModuleInfo } from "../src/nested/module-info";
import { decodeRequest, encodeReply, FRAME_BYTES, type Request, type WasmNumber } from "../src/nested/wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decode = (text: string) => decodeRequest(encoder.encode(text));

describe("runtime_nested wire", () => {
  test("keeps i64 and f64 bits that JSON numbers would round", () => {
    const min = "-9223372036854775808";
    const nan = "9221120237041090561";
    const request = decode(`{"Call":{"function":2147483649,"arguments":[{"I32":-1},{"I64":${min}},{"F32":2143289344},{"F64":${nan}}],"invocation":5}}`) as Extract<Request, { Call: unknown }>;
    expect(request.Call.arguments).toEqual([{ I32: -1 }, { I64: min }, { F32: 2143289344 }, { F64: nan }]);
  });

  test("does not rewrite a payload named inside a string", () => {
    const request = decode(String.raw`{"Function":{"instance":1,"name":"\"I64\":5"}}`) as Extract<Request, { Function: unknown }>;
    expect(request.Function.name).toBe('"I64":5');
  });

  test("writes the exact serde_json shapes", () => {
    const values: WasmNumber[] = [{ I32: 7 }, { I64: "-9007199254740993" }, { F32: 1 }, { F64: "2" }];
    expect(decoder.decode(encodeReply({ Values: values }))).toBe('{"Values":[{"I32":7},{"I64":-9007199254740993},{"F32":1},{"F64":2}]}');
    expect(decoder.decode(encodeReply("PendingException"))).toBe('"PendingException"');
    expect(decoder.decode(encodeReply("Null"))).toBe('"Null"');
    expect(decoder.decode(encodeReply({ Handle: 2147483649 }))).toBe('{"Handle":2147483649}');
    expect(JSON.parse(decoder.decode(encodeReply({ Error: { category: "LinkError", message: 'bad "name"' } })))).toEqual({ Error: { category: "LinkError", message: 'bad "name"' } });
  });

  test("freezes the callback frame size", () => expect(FRAME_BYTES).toBe(8 + 32 * 16));
});

function bytes(...sections: number[][]): Uint8Array {
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(sections.flat()));
}
const name = (text: string) => [text.length].concat(Array.from(encoder.encode(text)));
const section = (id: number, content: number[]) => [id, content.length].concat(content);

describe("module signatures", () => {
  const types = section(1, [2, 0x60, 2, 0x7f, 0x7e, 1, 0x7c, 0x60, 1, 0x7b, 0]);
  const imports = section(2, [2].concat(
    name("env"), name("peer"), [0, 0],
    name("env"), name("size"), [3, 0x7f, 0],
  ));
  const functions = section(3, [1, 1]);
  const exportsSection = section(7, [2].concat(name("own"), [0, 1], name("import"), [0, 0]));

  test("resolves export types through the import and function index spaces", () => {
    const info = readModuleInfo(bytes(types, imports, functions, exportsSection));
    expect(info.exports.get("import")).toEqual({ params: ["i32", "i64"], results: ["f64"] });
    expect(info.exports.get("own")).toEqual({ params: ["v128"], results: [] });
    expect(info.imports).toEqual([
      { kind: "function", module: "env", name: "peer", type: { params: ["i32", "i64"], results: ["f64"] } },
      { kind: "global", module: "env", name: "size", value: "i32", mutable: false },
    ]);
  });

  test("rejects a function type index outside the type section", () => {
    expect(() => readModuleInfo(bytes(types, section(3, [1, 9])))).toThrow("out of range");
  });
});
