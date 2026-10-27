import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { createContext, runInContext } from "node:vm";

// The runtime node:repl over native Bun's own transpiler and a separate global scope.
const source = fs.readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_repl.ts", import.meta.url), "utf8");
const factorySource = new Bun.Transpiler({ loader: "ts" }).transformSync("globalThis.factory = " + source);

function session(terminal: boolean) {
  const stdin = Object.assign(new EventEmitter(), { isTTY: terminal, pause() {} });
  let output = "";
  let errors = "";
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout: { isTTY: false, write: (chunk: string) => { output += chunk; } },
    stderr: { write: (chunk: string) => { errors += chunk; } },
  });
  const context = createContext({ Bun, Promise, Symbol, Object, Reflect, Error, TextDecoder, TextEncoder, console });
  runInContext(factorySource, context);
  const repl = context.factory({
    require: (name: string) => name === "process" ? process : EventEmitter,
    builtin: () => fs,
    native: { evalScript: (code: string) => runInContext(code, context) },
  });
  const server = repl.start();
  const exited = new Promise<void>(resolve => server.on("exit", resolve));
  return { stdin, process, context, server, exited, output: () => output, errors: () => errors };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("piped input evaluates in order with persistent TypeScript declarations and top-level await", async () => {
  const repl = session(false);
  repl.stdin.emit("data", "1 + 2\nconst answer: number = 40\nanswer + 2\nawait Promise.resolve('awaited')\n`two\nlines`\n");
  repl.stdin.emit("end");
  await repl.exited;
  expect(repl.output()).toBe(["3", "40", "42", Bun.inspect("awaited"), Bun.inspect("two\nlines")].join("\n") + "\n");
  expect(repl.errors()).toBe("");
});

test("an open bracket or block comment continues; an unterminated string is an error", async () => {
  const repl = session(false);
  repl.stdin.emit("data", "[1,\n2].length\n/* still\ncomment */ 7\n'broken\n8\n");
  repl.stdin.emit("end");
  await repl.exited;
  expect(repl.output()).toBe("2\n7\n8\n");
  expect(repl.errors()).not.toBe("");
});

test("Ctrl+C stops waiting for a pending evaluation and later input still runs", async () => {
  const repl = session(true);
  repl.stdin.emit("data", "await new Promise(() => {})\r");
  await settle();
  repl.process.emit("SIGINT");
  repl.stdin.emit("data", "5 + 5\r");
  await settle();
  expect(repl.output()).toContain("10\r\n");
  expect(repl.output()).not.toContain("To exit");
  repl.server.close();
});

test("input queued after .exit never runs", async () => {
  const repl = session(false);
  repl.stdin.emit("data", ".exit\nglobalThis.touched = 7\n");
  await repl.exited;
  await settle();
  expect(Reflect.get(repl.context, "touched")).toBeUndefined();
});

test("terminal editing echoes, recalls history and redraws", async () => {
  const repl = session(true);
  repl.stdin.emit("data", "40 + 1\r\x1b[A\x7f2\r");
  await settle();
  expect(repl.output()).toContain("41\r\n");
  expect(repl.output()).toContain("42\r\n");
  repl.server.close();
});
