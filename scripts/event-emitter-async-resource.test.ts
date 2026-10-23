import { expect, test } from "bun:test";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function events() {
  const modules = new Map();
  const internal = {
    builtin(name: string) {
      if (name === "node:async_hooks") return { AsyncResource };
      throw new Error(`Unexpected builtin ${name}`);
    },
    require(name: string) {
      if (modules.has(name)) return modules.get(name);
      const extension = name === "events" ? "js" : "ts";
      const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
      const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`));
      const module = factory(internal);
      modules.set(name, module);
      return module;
    },
  };
  return internal.require("events");
}

test("async emitter dispatches in its creation context and restores the caller", async () => {
  const { EventEmitterAsyncResource } = events();
  const storage = new AsyncLocalStorage<string>();
  const emitter = storage.run("creation", () => new EventEmitterAsyncResource({ name: "fixture" }));
  let seen: Promise<string | undefined> | undefined;
  emitter.on("event", function (this: unknown, value: number) {
    expect(this).toBe(emitter);
    expect(value).toBe(42);
    expect(storage.getStore()).toBe("creation");
    seen = Promise.resolve().then(() => storage.getStore());
  });
  storage.run("caller", () => {
    expect(emitter.emit("event", 42)).toBe(true);
    expect(storage.getStore()).toBe("caller");
  });
  expect(await seen).toBe("creation");
  expect(emitter.emit("absent")).toBe(false);
  expect(storage.getStore()).toBeUndefined();
});

test("throwing listener restores context and async resource retains its emitter", () => {
  const { EventEmitter, EventEmitterAsyncResource } = events();
  const storage = new AsyncLocalStorage<string>();
  const emitter = storage.run("creation", () => new EventEmitterAsyncResource("fixture"));
  const sentinel = new Error("listener");
  emitter.on("error", () => { expect(storage.getStore()).toBe("creation"); throw sentinel; });
  expect(emitter).toBeInstanceOf(EventEmitter);
  expect(emitter.asyncResource).toBeInstanceOf(AsyncResource);
  expect(emitter.asyncResource.eventEmitter).toBe(emitter);
  expect(emitter.asyncId).toBe(emitter.asyncResource.asyncId());
  expect(emitter.triggerAsyncId).toBe(emitter.asyncResource.triggerAsyncId());
  expect(() => emitter.emit("error")).toThrow(sentinel);
  expect(storage.getStore()).toBeUndefined();
  expect(emitter.emitDestroy()).toBeUndefined();
});

test("async emitter requires a name unless a subclass supplies it", () => {
  const { EventEmitterAsyncResource } = events();
  class Derived extends EventEmitterAsyncResource {}
  expect(new Derived()).toBeInstanceOf(EventEmitterAsyncResource);
  expect(() => new EventEmitterAsyncResource()).toThrow();
  expect(() => new EventEmitterAsyncResource({ name: 42 })).toThrow();
  expect(() => new EventEmitterAsyncResource({ name: "fixture", captureRejections: "yes" })).toThrow();
});
