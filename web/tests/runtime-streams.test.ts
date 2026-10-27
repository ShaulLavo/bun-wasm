import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-streams-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const js = join(root, "crates/bunwasm-runtime/src/js");

function emit(name: string): string {
  const destination = join(scratch, `${name}.js`);
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(js, `${name}.ts`), destination]);
  expect(result.exitCode).toBe(0);
  return readFileSync(destination, "utf8");
}

function syntax(text: string): string {
  const file = ts.createSourceFile("runtime.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(file);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(file)];
  }
  return JSON.stringify(visit(file));
}

const originalSyntaxAtPR140 = "d7a30a96ca47cdac8fc9e4bf52f3e83e237e45c75d6589d4adbd357a8a32fd94";

test("streams changes only approved normalization and the own-descriptor invariant", () => {
  const emitted = emit("streams");
  const original = emitted
    .replace("const convertedLabel = domString(label);", "label = domString(label);")
    .replace("const convertedOptions = dictionary(options);", "options = dictionary(options);")
    .replaceAll("convertedOptions.fatal", "options.fatal")
    .replaceAll("convertedOptions.ignoreBOM", "options.ignoreBOM")
    .replace("convertedLabel.toWellFormed()", "label.toWellFormed()")
    .replace(' if (!descriptor) throw new TypeError("Missing stream adapter descriptor");', "");
  expect(createHash("sha256").update(syntax(original)).digest("hex")).toBe(originalSyntaxAtPR140);
  expect(emitted).toContain('"use strict";');
  expect(emitted).toContain('if (!descriptor) throw new TypeError("Missing stream adapter descriptor");');
});

test("every emitted streams token keeps its final TypeScript line and column", () => {
  const source = readFileSync(join(js, "streams.ts"), "utf8");
  const lines = source.split("\n");
  const emitted = emit("streams");
  const file = ts.createSourceFile("streams.js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect(emitted.split("\n")).toHaveLength(lines.length);
  function visit(node: ts.Node): void {
    const children = node.getChildren(file);
    if (children.length) return void children.forEach(visit);
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    const token = node.getText(file);
    expect(lines[line]?.slice(character, character + token.length)).toBe(token);
  }
  visit(file);
});

function check(source: string) {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(probe, "declare const internal: BunWasm.Internal;\n" + source);
  writeFileSync(config, JSON.stringify({ extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [], files: [join(js, "runtime.d.ts"), probe] }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("accepts decoder, text transformer and compression native contracts", () => {
  const result = check(`
const native = internal.native.streams;
const decoder = native.decoder("utf-8", true, false);
const text: string = native.push(decoder.id, internal.toUint8(new DataView(new ArrayBuffer(3))), false);
native.release(decoder.id);
const streams = internal.require("streams_polyfill");
const transformer = new streams.TransformStream<unknown, string>({ transform(_chunk, controller) { controller.enqueue(text); } });
const compressed = internal.require("compression_streams").create(streams.TransformStream, streams.ReadableStream, streams.WritableStream);
const bytes: ReadableStream<Uint8Array> = new compressed.CompressionStream("gzip").readable;
const handle = native.webCodec("gzip", false, 4, 1);
const more: boolean = native.webStep(handle, new Uint8Array(), true).more;
void [transformer, bytes, more];`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalid = [
  'internal.native.streams.decoder(7, false, false);',
  'internal.native.streams.decoder("utf-8", "fatal", false);',
  'internal.native.streams.decoder("utf-8", false);',
  'internal.native.streams.push(1, "bytes", false);',
  'internal.native.streams.release("handle");',
  'const bytes: Uint8Array = internal.native.streams.push(1, new Uint8Array(), true);',
  'new (internal.require("streams_polyfill").TransformStream)<unknown, string>({ transform(_chunk, controller) { controller.enqueue(new Uint8Array()); } });',
  'internal.native.streams.webStep(1, new Uint8Array(), "finish");',
  'internal.require("compression_streams").create(7);',
  `const streams = internal.require("streams_polyfill");
const web = internal.require("compression_streams").create(streams.TransformStream, streams.ReadableStream, streams.WritableStream);
new web.CompressionStream();`,
  `const streams = internal.require("streams_polyfill");
const web = internal.require("compression_streams").create(streams.TransformStream, streams.ReadableStream, streams.WritableStream);
new web.DecompressionStream("gzip").write("x");`,
  `const streams = internal.require("streams_polyfill");
const web = internal.require("compression_streams").create(streams.TransformStream, streams.ReadableStream, streams.WritableStream);
new web.CompressionStream("gzip").destroy();`,
  'const pair: BunWasm.CompressionStreamPair = new (internal.builtin("node:stream").Transform)("gzip", false);',
  'new (internal.builtin("node:stream").Transform)("gzip", false).readable;',
];
for (const source of invalid) {
  test(`rejects the invalid stream contract ${source}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

function portable(scenario: string, missingDescriptor = false): unknown {
  const context = { TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, TransformStream, ReadableStream, WritableStream, TypeError, Error };
  return runInNewContext(`
const events = [];
let finalize;
const registrations = new Map();
class Registry {
  constructor(callback) { finalize = callback; }
  register(token, id, key) { events.push(["register", id]); registrations.set(key, id); }
  unregister(token) { events.push(["unregister", registrations.get(token)]); return registrations.delete(token); }
}
const FinalizationRegistry = Registry;
const sentinel = new Error("sentinel");
let failPush = false;
const decoders = new Map();
const internal = {
  native: { engine: "quickjs", utf8Encode: text => new TextEncoder().encode(text), streams: {
    decoder(label, fatal, ignoreBOM) { events.push(["decoder", label, fatal, ignoreBOM]); const id = decoders.size + 1; decoders.set(id, new TextDecoder(label, {fatal, ignoreBOM})); return {id, encoding: "utf-8"}; },
    push(id, bytes, last) { events.push(["push", id, Array.from(bytes), last]); if (failPush) throw sentinel; return decoders.get(id).decode(bytes, {stream: !last}); },
    release(id) { events.push(["release", id]); },
  } },
  toUint8(value) { if (value === sentinel) throw sentinel; if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength); if (value instanceof ArrayBuffer) return new Uint8Array(value); throw new TypeError("Expected an ArrayBuffer or ArrayBufferView"); },
  require(name) { if (name === "streams_polyfill") return polyfill; if (name === "compression_streams") return compression; throw new Error(name); },
};
const polyfill = (${readFileSync(join(js, "streams_polyfill.js"), "utf8")})(internal);
const compression = (${emit("compression_streams")})(internal);
const getDescriptor = Object.getOwnPropertyDescriptor;
if (${missingDescriptor}) Object.getOwnPropertyDescriptor = (target, key) => key === "encoding" ? undefined : getDescriptor(target, key);
let adapters;
try { adapters = (${emit("streams")})(internal); }
catch (error) { Object.getOwnPropertyDescriptor = getDescriptor; if (!${missingDescriptor}) throw error; returnValue = [error instanceof TypeError, error.message]; }
Object.getOwnPropertyDescriptor = getDescriptor;
${scenario}
`, Object.assign(context, { returnValue: undefined }));
}

test("the real portable wrapper fails closed on an absent own descriptor", () => {
  expect(portable("returnValue;", true)).toEqual([true, "Missing stream adapter descriptor"]);
});

test("the real portable wrapper preserves decoder release and finalizer calls", async () => {
  const result: unknown = await portable(`(async () => {
const stream = new adapters.TextDecoderStream();
const reader = stream.readable.getReader();
const writer = stream.writable.getWriter();
const reading = reader.read();
await writer.write(new Uint8Array([65]));
const first = await reading;
const done = reader.read();
await writer.close();
const last = await done;
reader.releaseLock(); writer.releaseLock();
return [first.value, last.done, stream.readable.locked, stream.writable.locked, events, registrations.size];
})()`);
  expect(result).toEqual(["A", true, false, false, [
    ["decoder", "utf-8", false, false], ["register", 1], ["push", 1, [65], false], ["push", 1, [], true], ["release", 1], ["unregister", 1],
  ], 0]);
});

for (const failure of ["convert", "push", "flush"]) {
  test(`the real portable wrapper preserves ${failure} error identity and release order`, async () => {
    const result: unknown = await portable(`(async () => {
const stream = new adapters.TextDecoderStream();
const reader = stream.readable.getReader(); const writer = stream.writable.getWriter();
const readError = reader.read().catch(error => error);
const closedError = writer.closed.catch(error => error);
failPush = ${failure !== "convert"};
const operation = ${failure === "flush" ? "writer.close()" : `writer.write(${failure === "convert" ? "sentinel" : "new Uint8Array([65])"})`};
const writeError = await operation.catch(error => error);
const same = writeError === sentinel && await readError === sentinel && await closedError === sentinel;
reader.releaseLock(); writer.releaseLock();
return [same, events.filter(event => event[0] === "release" || event[0] === "unregister"), registrations.size];
})()`);
    const released = failure === "convert" ? [["release", 1], ["unregister", 1]] : [["release", 1], ["unregister", 1], ["release", 1], ["unregister", undefined]];
    expect(result).toEqual([true, released, 0]);
  });
}

test("the real portable wrapper forwards finalizer identity to the native release", () => {
  const result = portable(`new adapters.TextDecoderStream(); finalize(1); events.filter(event => event[0] === "release");`);
  expect(result).toEqual([["release", 1]]);
});


test("portable conversion preserves original label and dictionary read order", () => {
  expect(portable(`
const order = [];
const label = { [Symbol.toPrimitive](hint) { order.push("label:" + hint); return "utf-8"; } };
const options = new Proxy({}, { get(_target, key) { order.push(key); return false; } });
new adapters.TextDecoderStream(label, options);
order;`)).toEqual(["label:string", "fatal", "ignoreBOM"]);
});

test("host wrapper returns the host text constructors and calls only the compression factory", () => {
  const host = { TextEncoderStream, TextDecoderStream, ReadableStream, TransformStream, WritableStream };
  const calls: unknown[][] = [];
  const output: unknown = runInNewContext(`(${emit("streams")})({
    native: { engine: "host" }, require(name) { record(name); return { create(...args) { record(...args); return {}; } }; }
  })`, Object.assign({}, host, { record(...args: unknown[]) { calls.push(args); } }));
  expect(output).toMatchObject(host);
  expect(calls).toEqual([["compression_streams"], [TransformStream, ReadableStream, WritableStream]]);
});
