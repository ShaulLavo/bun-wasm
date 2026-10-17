import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { SharedPipe } from "../src/subprocess.js";

const path = new URL("../../crates/bunwasm-runtime/src/js/child_process_ipc.ts", import.meta.url).pathname;
const emitted = Bun.spawnSync(["node", "-e", 'const fs=require("node:fs");const {stripTypeScriptTypes}=require("node:module");process.stdout.write(stripTypeScriptTypes(fs.readFileSync(process.argv[1],"utf8"),{mode:"strip"}));', path], { timeout: 10000 });
if (emitted.exitCode !== 0) throw new Error(emitted.stderr.toString());
const source = emitted.stdout.toString();

class Target extends EventEmitter {
  declare connected: boolean;
  declare send: (value: unknown, callback?: (error: Error | null) => void) => boolean;
  declare disconnect: () => void;
}

function channel(closed = false) {
  const input = new SharedPipe();
  const output = new SharedPipe();
  if (closed) output.close();
  const target = new Target();
  const ticks: (() => void)[] = [];
  const waiters: unknown[] = [];
  const errors: Error[] = [];
  target.on("error", error => errors.push(error));
  const factory = runInNewContext(source, { TextEncoder, TextDecoder, Error, TypeError });
  if (typeof factory !== "function") throw new Error("Expected the IPC factory");
  const ipc: unknown = factory({
    native: {
      hostChildPipe: (_id: number, fd: number) => fd === 4 ? 11 : 12,
      hostRead: () => input.read(),
      hostWrite: (_id: number, bytes: Uint8Array) => output.write(bytes),
      hostClose: (id: number) => { (id === 11 ? input : output).close(); return 0; },
    },
    require(name: string) { if (name === "buffer") return { Buffer }; throw new Error(`Unexpected module ${name}`); },
    nextTick(callback: () => void) { ticks.push(callback); },
    addIoWaiter(waiter: unknown) { waiters.push(waiter); },
  });
  if (!ipc || typeof ipc !== "object" || !("connectNode" in ipc) || typeof ipc.connectNode !== "function") throw new Error("Expected an IPC adapter");
  ipc.connectNode(target, {}, 1, { serialization: "json" });
  return {
    target, output, errors,
    ticks() { for (const callback of ticks.splice(0)) callback(); },
    close() { input.close(); output.close(); waiters.length = 0; ticks.length = 0; target.removeAllListeners(); },
  };
}

test("failed IPC writes return false and report the callback error", () => {
  const c = channel(true);
  try {
    let received: Error | null | undefined;
    expect(c.target.send("message", error => { received = error; })).toBe(false);
    c.ticks();
    expect(received).toBeInstanceOf(Error);
    expect(c.target.connected).toBe(false);
  } finally { c.close(); }
});

test("failed IPC writes without a callback emit an error", () => {
  const c = channel(true);
  try {
    c.target.send("message");
    c.ticks();
    expect(c.errors).toHaveLength(1);
  } finally { c.close(); }
});

test("a JSON getter that disconnects cannot enqueue a message afterward", () => {
  const c = channel();
  try {
    let received: Error | null | undefined;
    const value = { get task() { c.target.disconnect(); return "outer"; } };
    expect(c.target.send(value, error => { received = error; })).toBe(false);
    c.ticks();
    expect(received).toBeInstanceOf(Error);
    const bytes = c.output.read();
    if (typeof bytes === "number") throw new Error("Expected a disconnect frame");
    expect(new TextDecoder().decode(bytes)).toBe('["disconnect"]\n');
  } finally { c.close(); }
});
