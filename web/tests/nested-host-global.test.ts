import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GroupOp } from "../node_modules/waffle/group/protocol.ts";
import { section, utf8Name } from "../src/nested/binary";
import { readModuleInfo } from "../src/nested/module-info";
import { MODULE_PUBLICATION } from "../src/nested/publication";
import { BACKEND, BAD_FRAME, PENDING_EXCEPTION, type Binding, type Reply, type WasmNumber } from "../src/nested/wire";
import { count, counters, errorText, group, handle, type Member, type ReplyOf } from "./nested-host-owner";

const load = (name: string) => new Uint8Array(readFileSync(`${import.meta.dir}/${name}.wasm`));
const fixture = load("nested-global");
const maintained = (name: string) => load(`../../tests/fixtures/shared-wasm-memory/${name}`);
const members: Member[] = [];
function member(peer?: Member): Member {
  const next = peer ? sharedJoin(peer) : group().join();
  members.push(next);
  return next;
}
const { join: sharedJoin } = group();
afterEach(() => { for (const entry of members.splice(0)) entry.lease.stopped(); });

function compile(target: Member, bytes: Uint8Array): Reply {
  const [, region, pointer] = target.raw(GroupOp.CREATE, bytes.length, 16);
  new Uint8Array(target.memory.buffer, pointer!, bytes.length).set(bytes);
  try { return target.send({ Compile: { pointer: pointer!, length: bytes.length } }); }
  finally { target.raw(GroupOp.DETACH, region!); }
}
const bindings: Binding[] = [{ Global: { module: "env", name: "seed", value: { I32: 31 } } }, { Callback: { module: "env", name: "observe", id: 1 } }];
function instantiate(target: Member, module: number, memory: number): Reply {
  return target.send({ Instantiate: { module, memory, bindings, invocation: 1 } });
}
function start(target = member()) {
  const module = handle(compile(target, fixture));
  const memory = handle(target.send({ Reserve: { initial: 1, maximum: 1 } }));
  const instance = handle(instantiate(target, module, memory));
  expect(instance).toBeGreaterThanOrEqual(BACKEND);
  return { target, module, memory, instance };
}
function get(target: Member, instance: number, name: string) { return target.send({ GlobalGet: { instance, name } }); }
function set(target: Member, instance: number, name: string, value: WasmNumber) { return target.send({ GlobalSet: { instance, name, value } }); }
function call(target: Member, instance: number, name: string, args: WasmNumber[] = []) {
  const fn = (target.send({ Function: { instance, name } }) as ReplyOf<"Function">).Function;
  return target.send({ Call: { function: fn.id, arguments: args, invocation: 2 } });
}

function published(target: Member, bytes: Uint8Array): number {
  const description = new TextEncoder().encode('{"memory":{},"imports":[],"exports":[]}');
  const [, region, pointer] = target.raw(GroupOp.CREATE, description.length + bytes.length, 16);
  const storage = new Uint8Array(target.memory.buffer, pointer!, description.length + bytes.length);
  storage.set(description); storage.set(bytes, description.length);
  const token = target.raw(GroupOp.PUBLISH, MODULE_PUBLICATION, region!, 0, description.length)[1]!;
  target.raw(GroupOp.DETACH, region!);
  return token;
}
function moduleBytes(...sections: number[][]) { return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(...sections)); }
/** Valid extended constants are outside the regionizer's admitted set. The later export stays undecoded. */
const undecoded = moduleBytes(section(6, [2, 0x7f, 0, 0x41, 1, 0x41, 2, 0x6a, 0x0b, 0x7f, 0, 0x41, 3, 0x0b]), section(7, [1].concat(utf8Name("late"), [3, 1])));

describe("global admission", () => {
  test("admits maintained numeric exports and resolves their actual declaration indices", () => {
    const target = member();
    for (const name of ["table-global", "global-source"]) expect(handle(compile(target, maintained(name)))).toBeGreaterThanOrEqual(BACKEND);
    expect(Array.from(readModuleInfo(maintained("table-global")).globals)).toEqual([
      ["answer", { value: "i32", mutable: false }], ["answerAlias", { value: "i32", mutable: false }],
      ["counter", { value: "i32", mutable: true }], ["wide", { value: "i64", mutable: true }],
      ["float", { value: "f64", mutable: false }], ["vector", { value: "v128", mutable: false }],
      ["importedBase", { value: "i32", mutable: false }], ["importedBaseAlias", { value: "i32", mutable: false }],
      ["importedBase2", { value: "i32", mutable: false }],
    ]);
    expect(handle(compile(target, fixture))).toBeGreaterThanOrEqual(BACKEND);
  });

  for (const [name, bytes] of [["reference", maintained("global-reference")], ["undecoded", undecoded]] as const) {
    test(`Compile and AttachModule refuse ${name} exports before any instance or side effect`, () => {
      const target = member();
      let effects = 0;
      target.dispatch = () => { effects++; return 0; };
      const before = target.host.snapshot(), owner = counters(target.owner);
      expect(errorText(compile(target, bytes))).toBe("unsupported nested global export");
      expect(target.host.snapshot()).toEqual(before);
      expect(counters(target.owner)).toEqual(owner);
      const token = published(target, bytes), held = counters(target.owner);
      expect(errorText(target.send({ AttachModule: { token } }))).toBe("unsupported nested global export");
      expect(target.host.snapshot()).toEqual(before);
      expect(counters(target.owner)).toEqual(held);
      expect(effects).toBe(0);
      expect(handle(compile(target, fixture))).toBeGreaterThanOrEqual(BACKEND);
    });
  }
});

describe("live numeric globals", () => {
  test("reads each declared type, imported aliases and the post-start value", () => {
    const target = member();
    target.dispatch = (_invocation, _callback, pointer) => { new DataView(target.memory.buffer).setBigUint64(pointer + 16, 3n, true); return 0; };
    const { instance } = start(target);
    const expected = { seed: { I32: 31 }, answer: { I32: 42 }, counter: { I32: 7 }, counterAlias: { I32: 7 }, wide: { I64: 9 }, single: { F32: 1069547520 }, double: { F64: 4609434218613702656 }, fromSeed: { I32: 31 }, afterVector: { I32: 11 }, started: { I32: 3 } };
    for (const [name, value] of Object.entries(expected)) expect(get(target, instance, name)).toEqual({ Values: [value] });
  });

  test("writes through aliases and Wasm in both directions, independently per instance and member", () => {
    const target = sharedJoin(); members.push(target);
    const first = start(target), second = start(target), other = start(member(target));
    expect(set(target, first.instance, "counter", { I32: 21 })).toEqual({ Count: 0 });
    expect(get(target, first.instance, "counterAlias")).toEqual({ Values: [{ I32: 21 }] });
    expect(call(target, first.instance, "getCounter")).toEqual({ Values: [{ I32: 21 }] });
    expect(set(target, first.instance, "counterAlias", { I32: 22 })).toEqual({ Count: 0 });
    expect(get(target, first.instance, "counter")).toEqual({ Values: [{ I32: 22 }] });
    expect(call(target, first.instance, "setCounter", [{ I32: 23 }])).toEqual({ Values: [] });
    expect(get(target, first.instance, "counterAlias")).toEqual({ Values: [{ I32: 23 }] });
    expect(get(target, second.instance, "counter")).toEqual({ Values: [{ I32: 7 }] });
    expect(get(other.target, other.instance, "counter")).toEqual({ Values: [{ I32: 7 }] });
  });

  const vectors: readonly [string, string, readonly string[]][] = [
    ["counter", "I32", ["-2147483648", "-1", "2147483647"]],
    ["wide", "I64", ["-9223372036854775808", "9223372036854775807", "9007199254740993"]],
    ["single", "F32", ["2147483648", "1069547520", "1", "2139095039", "2139095040", "4286578688"]],
    ["double", "F64", ["9223372036854775808", "4609434218613702656", "1", "9218868437227405311", "9218868437227405312", "18442240474082181120"]],
  ];
  for (const [name, tag, values] of vectors) test(`round trips exact ${tag} wire values`, () => {
    const { target, instance } = start();
    for (const value of values) {
      expect(target.sendText(`{"GlobalSet":{"instance":${instance},"name":"${name}","value":{"${tag}":${value}}}}`)).toBe('{"Count":0}');
      expect(target.sendText(`{"GlobalGet":{"instance":${instance},"name":"${name}"}}`)).toBe(`{"Values":[{"${tag}":${value}}]}`);
    }
    if (name === "wide") expect(target.sendText(JSON.stringify({ Call: { function: (target.send({ Function: { instance, name: "getWide" } }) as ReplyOf<"Function">).Function.id, arguments: [], invocation: 1 } }))).toBe('{"Values":[{"I64":9007199254740993}]}');
  });

  test("NaNs remain NaNs without promising their payload bits", () => {
    const { target, instance } = start();
    set(target, instance, "single", { F32: 0x7fc00001 });
    const single = (get(target, instance, "single") as ReplyOf<"Values">).Values[0] as { F32: number };
    expect(Number.isNaN(new Float32Array(new Uint32Array([single.F32]).buffer)[0])).toBe(true);
    set(target, instance, "double", { F64: "9221120237041090561" });
    const double = (get(target, instance, "double") as ReplyOf<"Values">).Values[0] as { F64: number };
    expect(Number.isNaN(new Float64Array(new BigUint64Array([BigInt(double.F64)]).buffer)[0])).toBe(true);
  });

  test("refuses immutable, SIMD, wrong tags, non-global names and invalid instances", () => {
    const { target, instance } = start();
    expect(errorText(set(target, instance, "answer", { I32: 0 }))).toBe("immutable nested global");
    expect(get(target, instance, "answer")).toEqual({ Values: [{ I32: 42 }] });
    expect(errorText(get(target, instance, "vector"))).toBe("unsupported nested result value");
    const tags: WasmNumber[] = [{ I32: 8 }, { I64: "8" }, { F32: 8 }, { F64: "8" }];
    for (const value of tags) expect(errorText(set(target, instance, "vector", value))).toBe("incompatible nested global value type");
    for (const [name, index] of [["counter", 0], ["wide", 1], ["single", 2], ["double", 3]] as const) {
      const before = get(target, instance, name);
      for (const value of tags.filter((_, at) => at !== index)) expect(errorText(set(target, instance, name, value))).toBe("incompatible nested global value type");
      expect(get(target, instance, name)).toEqual(before);
    }
    for (const name of ["absent", "getCounter", "table", "memory"]) {
      expect(errorText(get(target, instance, name))).toBe("missing nested global");
      expect(errorText(set(target, instance, name, { I32: 0 }))).toBe("missing nested global");
    }
    for (const [id, message] of [[instance + 1, "invalid instance"], [0, "mixed-backend WebAssembly resource"]] as const) {
      expect(errorText(get(target, id, "counter"))).toBe(message);
      expect(errorText(set(target, id, "counter", { I32: 0 }))).toBe(message);
    }
  });
});

describe("global boundaries", () => {
  test("bad immutable tags and mutable imports are refused before instantiation", () => {
    const { target, module, memory } = start();
    const before = target.host.snapshot().instantiationAttempts;
    const bad: Binding[] = [{ Global: { module: "env", name: "seed", value: { F32: 0 } } }, bindings[1]!];
    expect(target.send({ Instantiate: { module, memory, bindings: bad, invocation: 1 } })).toEqual({ Error: { category: "LinkError", message: "incompatible nested global import type" } });
    const mutable = moduleBytes(section(2, [1].concat(utf8Name("env"), utf8Name("seed"), [3, 0x7f, 1])));
    const mutableId = handle(compile(target, mutable));
    expect(target.send({ Instantiate: { module: mutableId, memory, bindings: [bindings[0]!], invocation: 1 } })).toEqual({ Error: { category: "LinkError", message: "incompatible nested global import type" } });
    expect(target.host.snapshot().instantiationAttempts).toBe(before);
  });

  for (const mode of ["trap", "pending", "bad-frame"] as const) test(`a ${mode} start issues no instance and recovers`, () => {
    const { target, module, memory, instance } = start();
    target.dispatch = (_invocation, _callback, pointer) => {
      if (mode === "pending") return PENDING_EXCEPTION;
      if (mode === "bad-frame") return BAD_FRAME;
      new DataView(target.memory.buffer).setBigInt64(pointer + 16, -1n, true);
      return 0;
    };
    const before = target.host.snapshot();
    const reply = instantiate(target, module, memory);
    if (mode === "pending") expect(reply).toBe("PendingException");
    else expect(reply).toMatchObject({ Error: { category: "RuntimeError" } });
    expect(target.host.snapshot()).toMatchObject({ instances: before.instances, failedInstantiations: before.failedInstantiations + 1, activeInvocations: 0, coreFailed: false });
    expect(errorText(get(target, instance + 1, "started"))).toBe("invalid instance");
    target.dispatch = () => 0;
    const recovered = handle(instantiate(target, module, memory));
    expect(recovered).toBe(instance + 1);
    expect(get(target, recovered, "counter")).toEqual({ Values: [{ I32: 7 }] });
  });

  test("global requests reenter without adding an invocation", () => {
    const { target, instance } = start();
    target.dispatch = () => {
      expect(target.host.snapshot().activeInvocations).toBe(1);
      expect(set(target, instance, "counter", { I32: 67 })).toEqual({ Count: 0 });
      expect(get(target, instance, "counterAlias")).toEqual({ Values: [{ I32: 67 }] });
      expect(target.host.snapshot().activeInvocations).toBe(1);
      return 0;
    };
    expect(call(target, instance, "observeThenCounter")).toEqual({ Values: [{ I32: 67 }] });
    expect(target.host.snapshot().activeInvocations).toBe(0);
  });

  test("traffic owns nothing new and memory slot reuse does not change instance identity", () => {
    const { target, instance, memory } = start();
    const before = target.host.snapshot(), owner = counters(target.owner);
    const committed = target.owner.snapshot().committedBytes;
    for (let value = 0; value < 30; value++) {
      expect(set(target, instance, "counter", { I32: value })).toEqual({ Count: 0 });
      expect(get(target, instance, "counterAlias")).toEqual({ Values: [{ I32: value }] });
    }
    expect(target.host.snapshot()).toEqual(before);
    expect(counters(target.owner)).toEqual(owner);
    expect(target.owner.snapshot().committedBytes).toBe(committed);
    expect(count(target.send({ Release: { memory } }))).toBe(0);
    const replacement = handle(target.send({ Reserve: { initial: 1, maximum: 1 } }));
    expect(replacement).not.toBe(memory);
    expect(errorText(target.send({ Span: { memory } }))).toBe("invalid nested memory");
    expect(get(target, instance, "counter")).toEqual({ Values: [{ I32: 29 }] });
    target.lease.stopped();
    expect(counters(target.owner)).toEqual({ regions: 0, holds: 0, pins: 0, published: 0, watches: 0 });
  });
});
