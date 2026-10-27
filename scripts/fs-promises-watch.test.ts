import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { EventEmitter, getEventListeners } from "node:events";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
function productionSource() {
  const scratch = fs.mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-promise-watch-source-"));
  try {
    const destination = join(scratch, "watch.js");
    execFileSync("node", [new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL("fs_promises_watch.ts", directory).pathname, destination], { stdio: "pipe" });
    return fs.readFileSync(destination, "utf8");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
const emitted = productionSource();
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
    import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { EventEmitter, getEventListeners } from "node:events";
import { join } from "node:path";
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
  let callback: (event: string, filename: string | Buffer) => void = () => {};
  const watch = adapter()((_path: string, _options: unknown, listener: typeof callback) => {
    callback = listener;
    return Object.assign(watcher, { close() { closed++; watcher.emit("close"); } });
  }, String);
  return { watch, watcher, closed: () => closed, change: (name: string | Buffer) => callback("change", name) };
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
