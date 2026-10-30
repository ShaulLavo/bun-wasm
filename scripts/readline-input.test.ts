import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { Interface } from "node:readline";
import { runInNewContext } from "node:vm";

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const tasks: (() => void)[] = [];
  const factories: Record<string, () => unknown> = {};
  const context = { process: { stdin: input }, Uint8Array, TextDecoder };
  const internal = {
    builtinFactories: factories,
    native: { readStdin() { throw new Error("readline must not read stdin synchronously to EOF"); } },
    realTimers: { setImmediate(callback: () => void) { tasks.push(callback); } },
    require(name: string): unknown {
      if (name === "dns") return {};
      if (name === "events") return EventEmitter;
      const typed = new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url);
      const path = existsSync(typed) ? typed : new URL(`../crates/bunwasm-runtime/src/js/${name}.js`, import.meta.url);
      const code = new Bun.Transpiler({ loader: existsSync(typed) ? "ts" : "js" }).transformSync(`globalThis.factory = ${readFileSync(path, "utf8")}`);
      return runInNewContext(code, context)(internal);
    },
  };
  internal.require("builtins");
  const createReadline = factories["node:readline"];
  if (!createReadline) throw new Error("Missing node:readline builtin factory");
  const readline = createReadline() as typeof import("node:readline");
  function pump() { for (const task of tasks.splice(0)) task(); }
  return { input, output, readline, pump };
}

async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }

test("readline consumes process.stdin lines before EOF without blocking other work", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const lines: string[] = [];
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.on("line", line => lines.push(line));
  try {
    f.pump();
    f.input.write("first\nsecond");
    await tick();
    expect(lines).toEqual(["first"]);
    expect(closed).toBe(false);
    f.input.end("\nlast");
    await tick();
    expect(lines).toEqual(["first", "second", "last"]);
    expect(closed).toBe(true);
  } finally { rl.close(); f.input.destroy(); }
});

test("question waits for one line from the supplied stream and leaves it open", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input, output: f.output });
  const answers: string[] = [];
  let closed = false;
  rl.on("close", () => { closed = true; });
  try {
    rl.question("Prompt: ", answer => answers.push(answer));
    f.pump();
    expect(answers).toEqual([]);
    f.input.write("answer\n");
    await tick();
    expect(answers).toEqual(["answer"]);
    expect(f.output.read()?.toString()).toBe("Prompt: ");
    expect(closed).toBe(false);
  } finally { rl.close(); f.input.destroy(); f.output.destroy(); }
});

test("stdin async iteration yields a line while the pipe remains open", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const iterator = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.on("close", () => { closed = true; });
  try {
    const first = iterator.next();
    f.pump();
    f.input.write("first\n");
    expect(await first).toEqual({ done: false, value: "first" });
    expect(closed).toBe(false);
    const last = iterator.next();
    f.input.end();
    expect((await last).done).toBe(true);
  } finally { rl.close(); await iterator.return?.(); f.input.destroy(); }
});

function attachedListeners(input: PassThrough) {
  return [input.listenerCount("data"), input.listenerCount("end")];
}

test("closing an interface detaches its input without closing the shared stream", () => {
  const f = fixture();
  const baseline = attachedListeners(f.input);
  const rl = f.readline.createInterface({ input: f.input });
  rl.on("line", () => {});
  f.pump();
  rl.close();
  expect(attachedListeners(f.input)).toEqual(baseline);
  expect(f.input.destroyed).toBe(false);
  f.input.destroy();
});

test("close before scheduled startup does not attach input listeners", () => {
  const f = fixture();
  const baseline = attachedListeners(f.input);
  const rl: Interface = f.readline.createInterface({ input: f.input });
  rl.on("line", () => { throw new Error("closed interface delivered input"); });
  rl.close();
  f.pump();
  expect(attachedListeners(f.input)).toEqual(baseline);
  f.input.destroy();
});


test("readline decodes UTF-8 across binary chunks and flushes incomplete input", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const lines: string[] = [];
  rl.on("line", line => lines.push(line));
  try {
    f.pump();
    f.input.write(Buffer.from([0xe2]));
    f.input.write(Buffer.from([0x82, 0xac, 0x0a, 0xef, 0xbb]));
    f.input.write(Buffer.from([0xbf, 0x0a]));
    f.input.end(Buffer.from([0xe2]));
    await tick();
    expect(lines).toEqual(["€", "\ufeff", "�"]);
  } finally { rl.close(); f.input.destroy(); }
});

test("readline preserves an input stream's existing string encoding", async () => {
  const f = fixture();
  f.input.setEncoding("utf8");
  const rl = f.readline.createInterface({ input: f.input });
  const lines: string[] = [];
  rl.on("line", line => lines.push(line));
  try {
    f.pump();
    f.input.end("decoded €\n");
    await tick();
    expect(lines).toEqual(["decoded €"]);
    expect(f.input.readableEncoding).toBe("utf8");
  } finally { rl.close(); f.input.destroy(); }
});

test("pause before scheduled attachment holds buffered lines until resume", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const lines: string[] = [];
  rl.on("line", line => lines.push(line));
  try {
    rl.pause();
    f.pump();
    f.input.write("held\n");
    await tick();
    expect(lines).toEqual([]);
    rl.resume();
    await tick();
    expect(lines).toEqual(["held"]);
  } finally { rl.close(); f.input.destroy(); }
});

test("prompt resumes a previously paused reader", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const lines: string[] = [];
  rl.on("line", line => lines.push(line));
  try {
    f.pump();
    rl.pause();
    rl.prompt();
    f.input.write("hello\n");
    await tick();
    expect(lines).toEqual(["hello"]);
  } finally { rl.close(); f.input.destroy(); }
});

test("question resumes a previously paused reader", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const answers: string[] = [];
  rl.on("line", () => {});
  try {
    f.pump();
    rl.pause();
    rl.question("Answer: ", answer => answers.push(answer));
    f.input.write("hello\n");
    await tick();
    expect(answers).toEqual(["hello"]);
  } finally { rl.close(); f.input.destroy(); }
});

test("an overlapping question preserves the first callback and allows reentrant questions", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const answers: string[] = [];
  const second = (answer: string) => answers.push(`next:${answer}`);
  const first = (answer: string) => { answers.push(`first:${answer}`); rl.question("Next: ", second); };
  try {
    rl.question("First: ", first);
    rl.question("Ignored: ", answer => answers.push(`overwritten:${answer}`));
    f.pump();
    f.input.write("one\ntwo\n");
    await tick();
    expect(answers).toEqual(["first:one", "next:two"]);
  } finally { rl.close(); f.input.destroy(); }
});

test("promise questions preserve the outstanding answer owner", async () => {
  const f = fixture();
  const rl = f.readline.promises.createInterface({ input: f.input });
  let secondAnswered = false;
  try {
    const first = rl.question("First: ");
    void rl.question("Second: ").then(() => { secondAnswered = true; });
    f.pump();
    f.input.write("one\n");
    await tick();
    expect(secondAnswered).toBe(false);
    expect(await first).toBe("one");
  } finally { rl.close(); f.input.destroy(); }
});
