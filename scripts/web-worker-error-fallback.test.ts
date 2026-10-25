import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.workerFactory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/web_worker.ts", import.meta.url), "utf8")}`);

function workerFixture(native: { resolve(): string; stat(): { mode: number } }) {
  const starts: { filename: unknown; options: { eval: boolean } }[] = [];
  class ThreadWorker {
    readonly threadId = 1;
    constructor(filename: unknown, options: { eval: boolean }) { starts.push({ filename, options }); }
    on() { return this; }
    once() { return this; }
    unref() {}
    ref() {}
    postMessage() {}
    terminate() { return Promise.resolve(0); }
  }
  const factory = runInNewContext(source, { EventTarget, Event, MessageEvent, ErrorEvent, CloseEvent, URL, Blob, File, DOMException, setImmediate });
  const implementation = factory({
    require(name: string) {
      if (name === "worker_threads") return { Worker: ThreadWorker };
      if (name === "process") return { cwd: () => "/app", emit() {} };
      if (name === "node_url") return { fileURLToPath: (value: URL) => value.pathname };
      if (name === "path") return { resolve: (...parts: string[]) => parts.join("/") };
      throw new Error(`Unexpected module ${name}`);
    },
    native,
  });
  return { implementation, starts };
}

test("missing web worker entries become BuildMessage errors before spawn", () => {
  const { implementation, starts } = workerFixture({
    resolve() { throw new Error("missing"); }, stat() { throw new Error("missing"); },
  });
  expect(() => new implementation.Worker("./missing.js")).not.toThrow();
  const start = starts[0];
  if (!start) throw new Error("worker did not start");
  expect(start.filename).toBe('throw new Error("BuildMessage: ModuleNotFound resolving \\"./missing.js\\" (entry point)");');
  expect(start.options.eval).toBe(true);
});

test("resolved web worker entries still use normal file execution", () => {
  const { implementation, starts } = workerFixture({
    resolve() { return "/app/existing.js"; }, stat() { return { mode: 0 }; },
  });
  new implementation.Worker("./existing.js");
  const start = starts[0];
  if (!start) throw new Error("worker did not start");
  expect(start.filename).toBe("/app/existing.js");
  expect(start.options.eval).toBe(false);
});
