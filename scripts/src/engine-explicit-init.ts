import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { importedMemory } from "../../src/engine-kind.ts";
import { SHARED_GROUP_MAX_PAGES, type ProgramProfile } from "./program-profile.ts";

function readU32(bytes: Uint8Array, cursor: { offset: number }): number {
    let value = 0;
    let shift = 0;
    for (;;) {
        const byte = bytes[cursor.offset++];
        assert(byte !== undefined, "truncated u32");
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

function section(id: number, payload: Uint8Array): Buffer<ArrayBuffer> {
    return Buffer.concat([Buffer.from([id].concat(u32(payload.length))), payload]);
}

function sections(bytes: Uint8Array<ArrayBuffer>) {
    assert.deepEqual(Buffer.from(bytes.subarray(0, 8)), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const result: { id: number; payload: Uint8Array<ArrayBuffer>; raw: Uint8Array<ArrayBuffer> }[] = [];
    const cursor = { offset: 8 };
    while (cursor.offset < bytes.length) {
        const begin = cursor.offset;
        const id = bytes[cursor.offset++];
        assert(id !== undefined, "truncated section id");
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
        assert(kind !== undefined, "truncated export kind");
        entries.push({ name, kind, index: readU32(payload, cursor) });
    }
    assert.equal(cursor.offset, payload.length);
    return entries;
}

function encodeExport(entry: { name: string; kind: number; index: number }): Buffer<ArrayBuffer> {
    const name = Buffer.from(entry.name);
    return Buffer.concat([Buffer.from(u32(name.length)), name, Buffer.from([entry.kind].concat(u32(entry.index)))]);
}


/**
 * A shared-group side imports the group memory and must never export it (Waffle group admission).
 * Only QuickJS is qualified for the shared-group profile; JSC and Hermes inputs have no atomics.
 */
export function convertEngineInitializers(bytes: Uint8Array, engine: "quickjs" | "jsc" | "hermes", profile: ProgramProfile = "split"): Uint8Array<ArrayBuffer> {
    assert(profile === "split" || engine === "quickjs", `${engine} is not qualified for the shared-group profile`);
    const input = Buffer.from(bytes);
    const before = sections(input);
    const start = before.find((entry) => entry.id === 8);
    const exportSection = before.find((entry) => entry.id === 7);
    assert(start && exportSection, "shared artifact must have start and exports");
    const startIndex = readU32(start.payload, { offset: 0 });
    const original = exportsOf(exportSection.payload);
    assert(original.some((entry) => entry.name === "__wasm_apply_data_relocs" && entry.kind === 0));
    assert(original.some((entry) => entry.name === "__wasm_call_ctors" && entry.kind === 0));
    assert(!original.some((entry) => ["quickjs_initialize_memory", "quickjs_apply_data_relocs", "quickjs_call_ctors",
        "jsc_initialize_memory", "jsc_apply_data_relocs", "jsc_call_ctors",
        "hermes_initialize_memory", "hermes_apply_data_relocs", "hermes_call_ctors"].includes(entry.name)), "side is already converted or has contradictory initializers");
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(input));
    const memories = imports.filter((entry) => entry.kind === "memory");
    assert.deepEqual(memories, [{ module: "env", name: "memory", kind: "memory" }], "sole core-owned memory import");
    assert.equal(importedMemory(input)?.shared, profile === "shared-group", "side memory sharing must match its program profile");
    assert.deepEqual(imports.filter((entry) => entry.kind === "table"),
        [{ module: "env", name: "__indirect_function_table", kind: "table" }], "sole core-owned table import");
    assert(!original.some((entry) => entry.kind === 2 || entry.name === "memory"), "side must not already export memory");
    const globals = imports.filter((entry) => entry.kind === "global");
    const stackIndex = globals.findIndex((entry) => entry.module === "env" && entry.name === "__stack_pointer");
    assert(stackIndex >= 0, "shared stack import");
    const renamed = original.map((entry) => {
        if (entry.name === "__wasm_apply_data_relocs") return { ...entry, name: `${engine}_apply_data_relocs` };
        if (entry.name === "__wasm_call_ctors") return { ...entry, name: `${engine}_call_ctors` };
        return entry;
    }).concat([
        { name: `${engine}_initialize_memory`, kind: 0, index: startIndex },
        { name: "__stack_pointer", kind: 3, index: stackIndex },
    ], profile === "split" ? [{ name: "memory", kind: 2, index: 0 }] : []);
    const exports = Buffer.concat([Buffer.from(u32(renamed.length))].concat(renamed.map(encodeExport)));
    const changed = before.filter((entry) => entry.id !== 8).map((entry) => entry.id === 7 ? section(7, exports) : entry.raw);
    const outputParts: Uint8Array[] = [input.subarray(0, 8)];
    const result = Buffer.concat(outputParts.concat(changed));
    const after = sections(result);
    assert(!after.some((entry) => entry.id === 8));
    const afterExports = after.find((entry) => entry.id === 7);
    assert(afterExports);
    assert.deepEqual(exportsOf(afterExports.payload), renamed);
    const unchanged = (entries: ReturnType<typeof sections>) => entries.filter((entry) => entry.id !== 7 && entry.id !== 8).map((entry) => Buffer.from(entry.raw));
    assert.deepEqual(unchanged(after), unchanged(before), "all non-export/start bytes, including function bodies and dylink, unchanged");
    assert(WebAssembly.validate(result));
    const module = new WebAssembly.Module(result);
    const exported = profile === "split" ? [{ name: "memory", kind: "memory" }] : [];
    assert.deepEqual(WebAssembly.Module.exports(module).filter((entry) => entry.kind === "memory"), exported);
    assert.deepEqual(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "memory"), memories);
    return result;
}

/**
 * A shared-group PIE core: wasm-ld's start function (global relocations, guarded passive data,
 * the image's own TLS base and bss) becomes the explicit `core_initialize_memory` export, which a
 * group host calls before `__wasm_apply_data_relocs` and `__wasm_call_ctors`.
 */
export function convertCoreInitializers(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const input = Buffer.from(bytes);
    const before = sections(input);
    const start = before.find((entry) => entry.id === 8);
    const exportSection = before.find((entry) => entry.id === 7);
    assert(start && exportSection, "PIE core must have start and exports");
    const module = new WebAssembly.Module(input);
    assert.equal(WebAssembly.Module.customSections(module, "dylink.0").length, 1, "PIE core has one dylink.0 section");
    assert.deepEqual(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "memory"),
        [{ module: "env", name: "memory", kind: "memory" }], "PIE core imports the group memory");
    assert.deepEqual(importedMemory(input), { shared: true, maximum: SHARED_GROUP_MAX_PAGES }, "group memory is shared below the string-tag ceiling");
    const original = exportsOf(exportSection.payload);
    assert(!original.some((entry) => entry.kind === 2), "PIE core must not export memory");
    assert(!original.some((entry) => entry.name === "core_initialize_memory"), "core is already converted");
    for (const name of ["__wasm_apply_data_relocs", "__wasm_call_ctors", "_start"]) {
        assert(original.some((entry) => entry.name === name && entry.kind === 0), `PIE core exports ${name}`);
    }
    const renamed = original.concat([{ name: "core_initialize_memory", kind: 0, index: readU32(start.payload, { offset: 0 }) }]);
    const exports = Buffer.concat([Buffer.from(u32(renamed.length))].concat(renamed.map(encodeExport)));
    const changed = before.filter((entry) => entry.id !== 8).map((entry) => entry.id === 7 ? section(7, exports) : entry.raw);
    const result = Buffer.concat([input.subarray(0, 8) as Uint8Array].concat(changed));
    const unchanged = (entries: ReturnType<typeof sections>) => entries.filter((entry) => entry.id !== 7 && entry.id !== 8).map((entry) => Buffer.from(entry.raw));
    assert.deepEqual(unchanged(sections(result)), unchanged(before), "only the export and start sections change");
    assert(WebAssembly.validate(result));
    return result;
}

if (import.meta.main) {
    const [engine, input, output, flag] = process.argv.slice(2);
    const usage = "usage: engine-explicit-init.ts quickjs|jsc|hermes|core input.wasm output.wasm [--group]";
    assert((engine === "quickjs" || engine === "jsc" || engine === "hermes" || engine === "core") && input && output && (flag === undefined || flag === "--group"), usage);
    if (engine === "core") assert.equal(flag, "--group", "only a shared-group core has an explicit initializer");
    const bytes = readFileSync(input);
    writeFileSync(output, engine === "core" ? convertCoreInitializers(bytes) : convertEngineInitializers(bytes, engine, flag ? "shared-group" : "split"));
}
