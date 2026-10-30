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
  const readline = factories["node:readline"]() as typeof import("node:readline");
  function pump() { for (const task of tasks.splice(0)) task(); }
  return { input, output, readline, pump };
}

async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }

test("readline consumes process.stdin lines before EOF without blocking other work", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const lines: string[] = [];
  rl.on("line", line => lines.push(line));
  try {
    f.pump();
    f.input.write("first\nsecond");
    await tick();
    expect(lines).toEqual(["first"]);
    expect(rl.closed).toBe(false);
    f.input.end("\nlast");
    await tick();
    expect(lines).toEqual(["first", "second", "last"]);
    expect(rl.closed).toBe(true);
  } finally { rl.close(); f.input.destroy(); }
});

test("question waits for one line from the supplied stream and leaves it open", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input, output: f.output });
  const answers: string[] = [];
  try {
    rl.question("Prompt: ", answer => answers.push(answer));
    f.pump();
    expect(answers).toEqual([]);
    f.input.write("answer\n");
    await tick();
    expect(answers).toEqual(["answer"]);
    expect(f.output.read()?.toString()).toBe("Prompt: ");
    expect(rl.closed).toBe(false);
  } finally { rl.close(); f.input.destroy(); f.output.destroy(); }
});

test("stdin async iteration yields a line while the pipe remains open", async () => {
  const f = fixture();
  const rl = f.readline.createInterface({ input: f.input });
  const iterator = rl[Symbol.asyncIterator]();
  try {
    const first = iterator.next();
    f.pump();
    f.input.write("first\n");
    expect(await first).toEqual({ done: false, value: "first" });
    expect(rl.closed).toBe(false);
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
