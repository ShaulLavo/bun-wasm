import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { EventEmitter, getEventListeners } from "node:events";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
function productionSource(name: string) {
  const scratch = fs.mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-promise-watch-source-"));
  try {
    const destination = join(scratch, "watch.js");
    execFileSync("node", [new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL(`${name}.ts`, directory).pathname, destination], { stdio: "pipe" });
    return fs.readFileSync(destination, "utf8");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
const emitted = productionSource("fs_promises_watch");
const backendSource = productionSource("fs_watch");
function adapter() {
  return runInNewContext(emitted, { AbortSignal })();
}
function filesystem() {
  const factory = runInNewContext(readFileSync(new URL("node_fs.js", directory), "utf8"), { URL, Uint8Array, ArrayBuffer });
  return factory({ native: {}, require(name: string) {
    if (name === "fs_promises_watch") {
      return adapter();
    }
    if (name === "fs_watch") return () => ({ watch: fs.watch });
    return () => ({});
  } });
}

test("fs/promises exposes the watch imported by the Deno shim", () => {
  const { fs, promises } = filesystem();
  expect(typeof promises.watch).toBe("function");
  expect(fs.promises.watch).toBe(promises.watch);
});

function wrapperSource(value: object): string {
  const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
  const factory = runInNewContext(source.slice(source.indexOf("function wrapperSource(")) + "\nwrapperSource");
  return factory("node:fs/promises", value);
}

test("the exact shim import links through the production ESM wrapper", () => {
  const { promises } = filesystem();
  const program = `import { SourceTextModule } from "node:vm";
    import { readFileSync } from "node:fs";
    const target = new SourceTextModule(readFileSync(0, "utf8"));
    const importer = new SourceTextModule('import { watch } from "fs/promises";');
    await importer.link(() => target);
    console.log("linked");`;
  const output = execFileSync("node", ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", program], {
    input: wrapperSource(promises), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  expect(output.trim()).toBe("linked");
});

function controlled() {
  const watcher = new EventEmitter();
  let closed = 0;
  const watch = adapter()((_path: string, _options: unknown, listener: (event: string, filename: string | Buffer) => void) => {
    watcher.on("change", listener);
    return Object.assign(watcher, { close() { closed++; watcher.emit("close"); } });
  }, String);
  return { watch, watcher, closed: () => closed, change: (name: string | Buffer) => watcher.emit("change", "change", name) };
}

test("promise watcher delivers queued events and concurrent reads once in order", async () => {
  const control = controlled();
  const controller = new AbortController();
  const iterator = control.watch("file", { signal: controller.signal })[Symbol.asyncIterator]();
  try {
    control.change("first");
    expect(await iterator.next()).toEqual({ value: { eventType: "change", filename: "first" }, done: false });
    const first = iterator.next(), second = iterator.next();
    const name = Buffer.from("second");
    control.change(name);
    control.change("third");
    expect((await first).value.filename).toBe(name);
    expect((await second).value.filename).toBe("third");
    const pending = iterator.next();
    iterator.return();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    control.change("late");
    iterator.return();
    expect(control.closed()).toBe(1);
    expect(control.watcher.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  } finally { iterator.return(); }
});

test("abort rejects a pending read once and removes the watcher and signal listeners", async () => {
  const control = controlled();
  const controller = new AbortController();
  const iterator = control.watch("file", { signal: controller.signal })[Symbol.asyncIterator]();
  try {
    const pending = iterator.next();
    controller.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: "cancelled" });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(control.closed()).toBe(1);
    expect(control.watcher.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  } finally { iterator.return(); }
});

test("pre-aborted watches never open a watcher", async () => {
  const control = controlled();
  const controller = new AbortController();
  controller.abort("before open");
  const iterator = control.watch("file", { signal: controller.signal })[Symbol.asyncIterator]();
  await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: "before open" });
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
  expect(control.closed()).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toEqual([]);
});

test("watch errors reject pending reads and close without retaining listeners", async () => {
  const control = controlled();
  const iterator = control.watch("file")[Symbol.asyncIterator]();
  try {
    const pending = iterator.next();
    const error = new Error("EIO");
    control.watcher.emit("error", error);
    await expect(pending).rejects.toBe(error);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(control.closed()).toBe(1);
    expect(control.watcher.eventNames()).toEqual([]);
  } finally { iterator.return(); }
});

test("external close settles pending reads", async () => {
  const control = controlled();
  const iterator = control.watch("file")[Symbol.asyncIterator]();
  const pending = iterator.next();
  control.watcher.emit("close");
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(control.closed()).toBe(1);
  expect(control.watcher.eventNames()).toEqual([]);
});

test("invalid signals fail before opening a watcher", () => {
  const control = controlled();
  expect(() => control.watch("file", { signal: {} })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(control.closed()).toBe(0);
});

for (const implementation of ["native", "adapter"]) {
  test(`${implementation} receives real filesystem changes and cancels pending reads`, async () => {
    const directory = fs.mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-promise-watch-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("test timeout"), 1000);
    let iterator: AsyncIterator<{ eventType: string; filename: string | Buffer | undefined }> | undefined;
    try {
      const file = join(directory, "file.txt");
      fs.writeFileSync(file, "before");
      const watch = implementation === "native" ? fs.promises.watch : filesystem().promises.watch;
      iterator = watch(directory, { signal: controller.signal, encoding: "buffer" })[Symbol.asyncIterator]();
      const pending = iterator!.next();
      fs.writeFileSync(file, "after");
      const event = await pending;
      expect(event.done).toBe(false);
      expect(event.value.eventType).toBe("change");
      expect(Buffer.isBuffer(event.value.filename)).toBe(true);
      expect(event.value.filename.toString()).toBe("file.txt");
      controller.abort("finished");
      await expect(iterator!.next()).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: "finished" });
      expect(await iterator!.next()).toEqual({ value: undefined, done: true });
    } finally {
      controller.abort("cleanup");
      await iterator?.return?.();
      clearTimeout(timer);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("return before consuming a pre-aborted iterator suppresses further reads", async () => {
  const control = controlled();
  const controller = new AbortController();
  controller.abort("before open");
  const iterator = control.watch("file", { signal: controller.signal })[Symbol.asyncIterator]();
  iterator.return();
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
  expect(control.closed()).toBe(0);
});

function productionBackend() {
  let stamp = 0;
  let failure: Error | undefined;
  let poll: () => void = () => { throw new Error("No active watcher"); };
  let watcher: EventEmitter & { close(): void };
  const timers = new Set<object>();
  const stat = () => {
    if (failure) throw failure;
    return { ino: 1, size: stamp, mtimeMs: stamp, ctimeMs: stamp, isDirectory: () => false, isSymbolicLink: () => false };
  };
  const factory = runInNewContext(backendSource, { AbortSignal });
  const backend = factory({
    require: (name: string) => name === "events" ? EventEmitter : { Buffer },
    timers: {
      setInterval(callback: () => void) {
        poll = callback;
        const timer = { ref() {}, unref() {} };
        timers.add(timer);
        return timer;
      },
      clearInterval(timer: object) { expect(timers.delete(timer)).toBe(true); },
    },
    nextTick: queueMicrotask,
  })({ statSync: stat, lstatSync: stat, readdirSync: () => [], toPath: String, absolute: String });
  const watch = adapter()((...args: unknown[]) => { watcher = backend.watch(...args); return watcher; }, String);
  return {
    watch, handle: () => watcher, timers,
    change() { stamp++; poll(); },
    fail(error: Error) { failure = error; poll(); },
  };
}

async function consumeOne(iterable: AsyncIterable<{ filename: string | Buffer | undefined }>) {
  for await (const event of iterable) { expect(event.filename).toBe("file.txt"); break; }
}

test.each(["return", "abort", "error", "external-close", "break"] as const)("real callback backend releases all listeners after %s", async end => {
  const backend = productionBackend();
  const controller = new AbortController();
  const iterable = backend.watch("file.txt", { signal: controller.signal });
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    expect(backend.handle().listenerCount("change")).toBe(1);
    expect(backend.timers.size).toBe(1);
    const pending = iterator.next();
    const error = new Error("poll EIO");
    if (end === "return") iterator.return();
    if (end === "abort") controller.abort(error);
    if (end === "error") backend.fail(error);
    if (end === "external-close") backend.handle().close();
    if (end === "break") {
      backend.change();
      await pending;
      backend.change();
      await consumeOne(iterable);
    }
    if (end === "abort") await expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: error });
    if (end === "error") await expect(pending).rejects.toBe(error);
    if (end === "return" || end === "external-close") expect(await pending).toEqual({ value: undefined, done: true });
    await Promise.resolve();
    expect(backend.handle().eventNames()).toEqual([]);
    expect(backend.timers.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  } finally { iterator.return(); }
});
