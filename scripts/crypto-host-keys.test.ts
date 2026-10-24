import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-host-keys-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const original = readFileSync(join(import.meta.dir, "fixtures/crypto-host-keys.original.txt"), "utf8");
const methods = ["generateKey", "importKey", "exportKey", "sign", "verify", "encrypt", "decrypt", "deriveBits", "deriveKey", "wrapKey", "unwrapKey"] as const;
type Operation = typeof methods[number];
const lengths = [3, 5, 2, 3, 4, 3, 3, 3, 5, 4, 7];
const convertedPath = join(root, "crates/bunwasm-runtime/src/js/crypto_host_keys.ts");
function emitted(): string {
  const output = join(scratch, "crypto_host_keys.js");
  const command = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), convertedPath, output]);
  expect(command.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}
const candidates: [string, () => string][] = [["original", () => original], ["converted", emitted]];

function invoke(fn: unknown, receiver: unknown, args: unknown[]): unknown {
  if (typeof fn !== "function") throw new TypeError("Fixture requires a function");
  const result: unknown = Reflect.apply(fn, receiver, args);
  return result;
}
function install(source: string, internal: object): void {
  const factory: unknown = runInNewContext(source, { ArrayBuffer, Uint8Array, Promise }, { filename: "bun-wasm:crypto_host_keys" });
  invoke(factory, undefined, [internal]);
}
class FixtureKey {
  readonly type = "secret";
  readonly algorithm = { name: "HMAC", hash: { name: "SHA-256" } };
  readonly usages: KeyUsage[] = ["sign", "verify"];
  constructor(readonly extractable = true) {}
}
function fixture(source: string, failCapture?: string, failBind?: string) {
  const trace: string[] = [];
  const calls: { operation: Operation; receiver: unknown; args: unknown[] }[] = [];
  const provider = {};
  const key = new FixtureKey();
  const remembered = new Map<unknown, unknown>();
  const own = new WeakSet<object>();
  const failure = new Error("fixture failure");
  let reject = false;
  let rejectForeign = false;
  let rejectPromise = false;
  const nativePromise = Promise.resolve("foreign receiver");
  function result(operation: Operation, args: unknown[]): unknown {
    if (operation === "exportKey") return args[0] === "jwk" ? { kty: "oct", k: "AQID" } : Uint8Array.of(1, 2, 3).buffer;
    if (operation === "verify") return true;
    if (["importKey", "generateKey", "deriveKey", "unwrapKey"].includes(operation)) return key;
    return Uint8Array.of(1, 2, 3).buffer;
  }
  function capture(operation: Operation, index: number): void {
    const method = function (this: unknown, ...args: unknown[]) {
      calls.push({ operation, receiver: this, args });
      if (this !== provider && rejectForeign) throw failure;
      if (this !== provider) return nativePromise;
      if (rejectPromise) return Promise.reject(failure);
      if (reject) throw failure;
      return Promise.resolve(result(operation, args));
    };
    Object.defineProperty(method, "name", { value: operation });
    Object.defineProperty(method, "length", { value: lengths[index] });
    Object.defineProperty(method, "bind", { get() { trace.push(`bind:${operation}`); if (failBind === operation) throw failure; return Function.prototype.bind; } });
    Object.defineProperty(provider, operation, { configurable: true, get() {
      trace.push(`get:${operation}`);
      if (failCapture === operation) throw failure;
      return method;
    }, set(value: unknown) { Object.defineProperty(provider, operation, { value, writable: true, configurable: true, enumerable: true }); } });
  }
  methods.forEach(capture);
  const c = {
    buffer(value: unknown) {
      trace.push("buffer");
      if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
    },
    isWasmKey: (value: unknown) => typeof value === "object" && value !== null && own.has(value),
    isKey: (value: unknown) => remembered.has(value) || value === key,
    record: () => ({ algorithm: key.algorithm, extractable: true, usages: key.usages, key: { kty: "oct", k: "AQID" } }),
    rememberKey(value: unknown, data: unknown) { remembered.set(value, data); },
    encode: () => "AQID", decode: () => Uint8Array.of(1, 2, 3), supportsAlgorithm: () => true,
    crypt: () => Uint8Array.of(1, 2, 3),
  };
  const internal = { crypto: c, native: { subtleCrypto: provider } };
  return { provider, key, own, c, trace, calls, remembered, failure, nativePromise,
    install: () => install(source, internal), reject: () => { reject = true; }, rejectForeign: () => { rejectForeign = true; }, rejectAsync: () => { rejectPromise = true; } };
}

for (const [label, source] of candidates) {
  test(`${label}: captures every getter before binding, including throwing getters`, () => {
    const f = fixture(source());
    f.install();
    expect(f.trace.slice(0, 22)).toEqual(methods.map(name => `get:${name}`).concat(methods.map(name => `bind:${name}`)));
    const throwing = fixture(source(), "decrypt");
    expect(throwing.install).toThrow(throwing.failure);
    expect(throwing.trace).toEqual(methods.slice(0, 7).map(name => `get:${name}`));
    const binding = fixture(source(), undefined, "exportKey");
    expect(binding.install).toThrow(binding.failure);
    expect(binding.trace).toEqual(methods.map(name => `get:${name}`).concat(methods.slice(0, 3).map(name => `bind:${name}`)));
  });

  test(`${label}: wrappers preserve receivers, original promises, name, length and descriptors`, async () => {
    const f = fixture(source());
    f.install();
    for (const [index, operation] of methods.entries()) {
      const method: unknown = Reflect.get(f.provider, operation);
      expect(typeof method).toBe("function");
      expect(Object.getOwnPropertyDescriptor(method, "name")?.value).toBe(operation);
      expect(Object.getOwnPropertyDescriptor(method, "length")?.value).toBe(lengths[index]);
      expect(Object.getOwnPropertyDescriptor(f.provider, operation)).toMatchObject({ writable: true, configurable: true, enumerable: true });
      for (const receiver of [undefined, null, false, 0, "", {}]) {
        expect(invoke(method, receiver, ["sentinel"])).toBe(f.nativePromise);
        expect(f.calls.at(-1)?.receiver).toBe(receiver);
      }
    }
    f.rejectForeign();
    expect(() => invoke(Reflect.get(f.provider, "sign"), {}, [])).toThrow(f.failure);
    const value = invoke(Reflect.get(f.provider, "sign"), f.provider, ["HMAC", f.key, new Uint8Array()]);
    expect(Object.prototype.toString.call(value)).toBe("[object Promise]");
    await expect(value).resolves.toBeInstanceOf(ArrayBuffer);
    f.reject();
    let rejected: unknown;
    expect(() => { rejected = invoke(Reflect.get(f.provider, "sign"), f.provider, ["HMAC", f.key, new Uint8Array()]); }).not.toThrow();
    await expect(rejected).rejects.toBe(f.failure);
  });

  test(`${label}: disabled and falsy providers never read crypto methods`, () => {
    for (const provider of [undefined, null, false, 0, ""]) {
      install(source(), { crypto: {}, native: { subtleCrypto: provider } });
    }
  });

  test(`${label}: import snapshots fields in order before provider validation`, async () => {
    const f = fixture(source());
    f.install();
    const reads: string[] = [];
    const fields = ["kty", "crv", "k", "n", "e", "d", "p", "q", "dp", "dq", "qi", "x", "y"];
    const data = Object.fromEntries(fields.map(field => [field, "x"]));
    for (const field of fields) Object.defineProperty(data, field, { get() { reads.push(field); return field === "k" ? "AQID" : "x"; } });
    await invoke(Reflect.get(f.provider, "importKey"), f.provider, ["jwk", data, "HMAC", true, ["sign"]]);
    expect(reads).toEqual(fields);
    expect(f.calls[0]?.args[1]).toBe(data);
    expect(f.remembered.get(f.key)).toMatchObject({ k: "AQID" });
    const failure = new Error("input getter");
    const broken = { get kty() { throw failure; } };
    const before = f.calls.length;
    await expect(invoke(Reflect.get(f.provider, "importKey"), f.provider, ["jwk", broken, "HMAC", true, ["sign"]])).rejects.toBe(failure);
    expect(f.calls.length).toBe(before);
  });

  test(`${label}: coercible and unsupported formats retain their original ordering`, async () => {
    const f = fixture(source());
    f.install();
    const key = new FixtureKey();
    f.own.add(key);
    const coercions: string[] = [];
    const format = { toString() { coercions.push("format"); return "raw"; } };
    await invoke(Reflect.get(f.provider, "exportKey"), f.provider, [format, f.key]);
    expect(coercions).toEqual([]);
    expect(f.calls[0]?.args[0]).toBe(format);
    await invoke(Reflect.get(f.provider, "exportKey"), f.provider, [format, key]);
    expect(coercions).toEqual(["format"]);
    expect(f.calls.at(-1)?.args[0]).toBe("raw");
    const before = f.calls.length;
    await expect(invoke(Reflect.get(f.provider, "importKey"), f.provider, [format, {}, "HMAC", true, ["sign"]])).rejects.toBeInstanceOf(TypeError);
    expect(f.calls.length).toBe(before);
    expect(coercions).toEqual(["format"]);
    await invoke(Reflect.get(f.provider, "importKey"), f.provider, [false, new Uint8Array(3), "HMAC", true, ["sign"]]);
    expect(f.calls[before]?.args[0]).toBe(false);
  });

  test(`${label}: conversion cache is shared and byte/algorithm snapshots precede awaits`, async () => {
    const f = fixture(source());
    f.install();
    const key = new FixtureKey();
    f.own.add(key);
    const data = Uint8Array.of(7, 8), iv = Uint8Array.of(9, 10);
    const params = { name: "AES-GCM", iv };
    const one = invoke(Reflect.get(f.provider, "encrypt"), f.provider, [params, key, data]);
    const two = invoke(Reflect.get(f.provider, "encrypt"), f.provider, [params, key, data]);
    data.fill(0); iv.fill(0);
    await Promise.all([one, two]);
    expect(f.calls.filter(call => call.operation === "importKey")).toHaveLength(1);
    const encrypted = f.calls.filter(call => call.operation === "encrypt");
    expect(encrypted).toHaveLength(2);
    expect(encrypted[0]?.args[1]).toBe(f.key);
    expect(encrypted[1]?.args[1]).toBe(f.key);
    expect(encrypted[0]?.args[2]).toEqual(Uint8Array.of(7, 8));
    expect(encrypted[0]?.args[0]).toEqual({ name: "AES-GCM", iv: Uint8Array.of(9, 10) });
  });

  test(`${label}: falsy algorithms, missing data, rejected conversion cache and coercion throws`, async () => {
    const f = fixture(source());
    f.install();
    await invoke(Reflect.get(f.provider, "deriveBits"), f.provider, [null, f.key, 0]);
    expect(f.calls[0]?.args).toEqual([null, f.key, 0]);
    await invoke(Reflect.get(f.provider, "sign"), f.provider, [false, f.key]);
    expect(f.calls[1]?.args).toEqual([false, f.key]);
    await invoke(Reflect.get(f.provider, "importKey"), f.provider, ["jwk", 0, "HMAC", true, ["sign"]]);
    expect(f.remembered.get(f.key)).toEqual({});
    const portable = new FixtureKey();
    f.own.add(portable);
    const failure = new Error("coercion");
    await expect(invoke(Reflect.get(f.provider, "exportKey"), f.provider, [{ toString() { throw failure; } }, portable])).rejects.toBe(failure);
    f.rejectAsync();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(invoke(Reflect.get(f.provider, "sign"), f.provider, ["HMAC", portable, new Uint8Array()])).rejects.toBe(f.failure);
    }
    expect(f.calls.filter(call => call.operation === "importKey")).toHaveLength(2);
  });

  test(`${label}: real Node WebCrypto control`, () => {
    const input = join(scratch, `${label}.js`);
    writeFileSync(input, source());
    const result = Bun.spawnSync(["node", join(import.meta.dir, "fixtures/crypto-host-native-control.ts"), input]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ host: "Node", nativeKey: true, remembered: true, extractable: false, verified: true,
      exportError: "InvalidAccessError", algorithmError: "NotSupportedError" });
  });


}

test("original snapshot is the exact pinned source", () => {
  expect(createHash("sha256").update(original).digest("hex")).toBe("7b790756bd37ed7f427f6c4b735a0af2658b3b7559ad913051e50f447649f5d8");
});

function statements(text: string): ts.Statement[] {
  const source = ts.createSourceFile("runtime.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)) throw new Error("Expected factory expression");
  const factory = statement.expression.expression;
  if (!ts.isFunctionExpression(factory)) throw new Error("Expected factory function");
  return Array.from(factory.body.statements);
}
function syntax(node: ts.Node): string {
  const children = node.getChildren();
  return JSON.stringify(children.length ? [node.kind, children.map(syntax)] : [node.kind, node.getText()]);
}
function statementKey(node: ts.Statement): string {
  if (ts.isFunctionDeclaration(node)) return `function:${node.name?.text}`;
  if (ts.isVariableStatement(node)) return `variable:${node.declarationList.declarations[0]?.name.getText()}`;
  if (ts.isExpressionStatement(node)) return node.expression.getText().split("=")[0]?.trim() ?? "";
  if (ts.isForOfStatement(node)) return `for:${node.expression.getText()}`;
  return node.getText();
}

test("only the approved executable statements change; every remaining AST and strict directive agrees", () => {
  const before = new Map(statements(original).map(node => [statementKey(node), syntax(node)]));
  const after = new Map(statements(emitted()).map(node => [statementKey(node), syntax(node)]));
  const changed = ["variable:original", "variable:host", "function:cloneData", "function:importHost", "function:toHost", "function:keyOperation"];
  const replaced = 'for:["sign", "verify", "encrypt", "decrypt"]';
  const added = ["provider.sign", "provider.verify", "provider.encrypt", "provider.decrypt"];
  expect(Array.from(before.keys()).filter(key => !after.has(key))).toEqual([replaced]);
  expect(Array.from(after.keys()).filter(key => !before.has(key))).toEqual(added);
  for (const [key, value] of before) {
    if (key === replaced) continue;
    expect(after.get(key) === value, key).toBe(!changed.includes(key));
  }
  const directive = statements(emitted())[0];
  if (!directive) throw new Error("Missing strict directive");
  expect(statementKey(directive)).toBe('"use strict"');
});

test("erasure retains every executable token's TypeScript line and column, not the old JavaScript locations", () => {
  const typed = readFileSync(convertedPath, "utf8");
  const text = emitted();
  const typedLines = typed.split("\n");
  const source = ts.createSourceFile("emitted.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect(text.split("\n")).toHaveLength(typedLines.length);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const location = source.getLineAndCharacterOfPosition(scanner.getTokenPos());
    const token = scanner.getTokenText();
    expect(typedLines[location.line]?.slice(location.character, location.character + token.length)).toBe(token);
  }
  expect(text).not.toBe(original);
});

function contract(source: string) {
  const probe = join(scratch, "contract.ts"), config = join(scratch, "tsconfig.json");
  writeFileSync(probe, 'declare const host: BunWasm.CryptoHostProvider;\ndeclare const key: CryptoKey;\n' + source);
  writeFileSync(config, JSON.stringify({ extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
    files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), join(root, "crates/bunwasm-runtime/src/js/crypto_host_types.d.ts"), probe] }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
}

test("strict host contracts preserve structured exports and operation-specific async results", () => {
  const result = contract(`
    const bytes = new Uint8Array(4);
    const signature: Promise<ArrayBuffer> = host.sign("HMAC", key, bytes);
    const verified: Promise<boolean> = host.verify("HMAC", key, bytes, bytes);
    const exported: Promise<JsonWebKey | ArrayBuffer> = host.exportKey("jwk", key);
    host.importKey("raw", bytes, {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
    host.importKey("jwk", {kty:"oct", k:"AQID"}, "HMAC", true, ["verify"]);
    host.importKey(false, bytes, "HMAC", true, ["sign"]);
    host.exportKey({toString() { return "raw"; }}, key);
    host.sign("HMAC", key);
    host.deriveKey({name:"ECDH", public:key}, key, {name:"AES-GCM"}, false, ["encrypt"]);
  `);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

for (const source of [
  'const value: Promise<boolean> = host.sign("HMAC", key, new Uint8Array());',
  'const value: Promise<ArrayBuffer> = host.verify("HMAC", key, new Uint8Array(), new Uint8Array());',
  'host.encrypt("AES-GCM", 7, new Uint8Array());',
  'host.importKey("raw", 7, "HMAC", false, ["sign"]);',
  'host.importKey("jwk", {}, "HMAC", false, ["dance"]);',
  'host.deriveKey({name:"ECDH", public:7}, key, "AES-GCM", false, ["encrypt"]);',
  'host.unwrapKey("raw", "bytes", key, "AES-KW", "HMAC", false, ["sign"]);',
]) {
  test(`strict host contracts reject ${source}`, () => {
    const result = contract(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

test("the converted source stays strict and contains no unsafe type escapes", () => {
  const text = readFileSync(convertedPath, "utf8");
  const source = ts.createSourceFile(convertedPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const forbidden: string[] = [];
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) forbidden.push(node.getText(source));
    if (ts.isAsExpression(node) && node.type.getText(source) !== "const") forbidden.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(forbidden).toEqual([]);
  expect(text).not.toMatch(/@ts-(ignore|nocheck|expect-error)/);
  const config = JSON.parse(readFileSync(join(root, "crates/bunwasm-runtime/tsconfig.json"), "utf8"));
  expect(config.compilerOptions.strict).toBe(true);
  expect(config.compilerOptions.erasableSyntaxOnly).toBe(true);
  expect(statements(original).length).toBe(new Set(statements(original).map(statementKey)).size);
  expect(statements(emitted()).length).toBe(new Set(statements(emitted()).map(statementKey)).size);
});
