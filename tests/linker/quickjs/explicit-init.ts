import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

function readU32(bytes: Uint8Array, cursor: { offset: number }): number {
    let value = 0;
    let shift = 0;
    for (;;) {
        const byte = bytes[cursor.offset++];
        assert.notEqual(byte, undefined, "truncated u32");
        value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
        shift += 7;
        assert(shift <= 28, "u32 overflow");
    }
}

function u32(value: number): number[] {
    const bytes: number[] = [];
    do {
        const next = value >>> 7;
        bytes.push((value & 127) | (next ? 128 : 0));
        value = next;
    } while (value);
    return bytes;
}

function section(id: number, payload: Uint8Array): Buffer {
    return Buffer.concat([Buffer.from([id].concat(u32(payload.length))), payload]);
}

function sections(bytes: Uint8Array) {
    assert.deepEqual(Buffer.from(bytes.subarray(0, 8)), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const result: { id: number; payload: Uint8Array; raw: Uint8Array }[] = [];
    const cursor = { offset: 8 };
    while (cursor.offset < bytes.length) {
        const begin = cursor.offset;
        const id = bytes[cursor.offset++];
        const size = readU32(bytes, cursor);
        const end = cursor.offset + size;
        assert(end <= bytes.length, "truncated section");
        result.push({ id, payload: bytes.subarray(cursor.offset, end), raw: bytes.subarray(begin, end) });
        cursor.offset = end;
    }
    return result;
}

function exportsOf(payload: Uint8Array) {
    const cursor = { offset: 0 };
    const count = readU32(payload, cursor);
    const entries: { name: string; kind: number; index: number }[] = [];
    for (let i = 0; i < count; i++) {
        const length = readU32(payload, cursor);
        const name = Buffer.from(payload.subarray(cursor.offset, cursor.offset + length)).toString("utf8");
        cursor.offset += length;
        const kind = payload[cursor.offset++];
        entries.push({ name, kind, index: readU32(payload, cursor) });
    }
    assert.equal(cursor.offset, payload.length);
    return entries;
}

function encodeExport(entry: { name: string; kind: number; index: number }): Buffer {
    const name = Buffer.from(entry.name);
    return Buffer.concat([Buffer.from(u32(name.length)), name, Buffer.from([entry.kind].concat(u32(entry.index)))]);
}

const [input, output] = process.argv.slice(2);
assert(input && output, "usage: explicit-init.ts input.wasm output.wasm");
const before = sections(readFileSync(input));
const start = before.find((entry) => entry.id === 8);
const exportSection = before.find((entry) => entry.id === 7);
assert(start && exportSection, "shared artifact must have start and exports");
const startIndex = readU32(start.payload, { offset: 0 });
const original = exportsOf(exportSection.payload);
assert(original.some((entry) => entry.name === "__wasm_apply_data_relocs"));
assert(original.some((entry) => entry.name === "__wasm_call_ctors"));
const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(input)));
const memories = imports.filter((entry) => entry.kind === "memory");
assert.deepEqual(memories, [{ module: "env", name: "memory", kind: "memory" }], "sole core-owned memory import");
assert(!original.some((entry) => entry.kind === 2 || entry.name === "memory"), "side must not already export memory");
const globals = imports.filter((entry) => entry.kind === "global");
const stackIndex = globals.findIndex((entry) => entry.module === "env" && entry.name === "__stack_pointer");
assert(stackIndex >= 0, "shared stack import");
const renamed = original.map((entry) => {
    if (entry.name === "__wasm_apply_data_relocs") return { ...entry, name: "quickjs_apply_data_relocs" };
    if (entry.name === "__wasm_call_ctors") return { ...entry, name: "quickjs_call_ctors" };
    return entry;
}).concat([
    { name: "quickjs_initialize_memory", kind: 0, index: startIndex },
    { name: "__stack_pointer", kind: 3, index: stackIndex },
    { name: "memory", kind: 2, index: 0 },
]);
const exports = Buffer.concat([Buffer.from(u32(renamed.length))].concat(renamed.map(encodeExport)));
const changed = before.filter((entry) => entry.id !== 8).map((entry) => entry.id === 7 ? section(7, exports) : entry.raw);
const result = Buffer.concat([readFileSync(input).subarray(0, 8)].concat(changed));
const after = sections(result);
assert(!after.some((entry) => entry.id === 8));
const afterExports = after.find((entry) => entry.id === 7);
assert(afterExports);
assert.deepEqual(exportsOf(afterExports.payload), renamed);
const unchanged = (entries: ReturnType<typeof sections>) => entries.filter((entry) => entry.id !== 7 && entry.id !== 8).map((entry) => Buffer.from(entry.raw));
assert.deepEqual(unchanged(after), unchanged(before), "all non-export/start bytes, including function bodies and dylink, unchanged");
assert(WebAssembly.validate(result));
const module = new WebAssembly.Module(result);
assert.deepEqual(WebAssembly.Module.exports(module).filter((entry) => entry.kind === "memory"), [{ name: "memory", kind: "memory" }]);
assert.deepEqual(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "memory"), memories);
writeFileSync(output, result);
console.log(JSON.stringify({ startIndex, unchangedCodeAndMetadata: true, explicitInitializers: renamed.filter((entry) => entry.name.startsWith("quickjs_")).map((entry) => entry.name) }));
