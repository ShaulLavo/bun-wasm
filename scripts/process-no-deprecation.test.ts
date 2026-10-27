import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type WarningEvent = { name: string; code?: string; message: string };
type GuestProcess = {
  noDeprecation?: boolean;
  on(event: "warning", listener: (warning: WarningEvent) => void): unknown;
  off(event: "warning", listener: (warning: WarningEvent) => void): unknown;
  emitWarning(warning: string, type: string): void;
};

function loadCurrent(): GuestProcess {
  const stderr: string[] = [];
  const native = {
    platformInfo: { version: "test", revision: "test", arch: "wasm32" },
    env: () => ({}),
    argv: () => ["bun", "fixture.ts"],
    execArgv: () => [],
    execPath: () => "/bin/bun",
    writeStderr(text: string) { stderr.push(text); },
    hostSignal() { return 0; },
    memoryUsage: () => ({ rss: 0 }),
    now: () => 0,
  };
  const internal = {
    native,
    nextTick(callback: () => void) { queueMicrotask(callback); },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "process_signals") return () => () => false;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/process.ts", import.meta.url), "utf8");
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
  const context: { factory?: (internal: unknown) => unknown; process: typeof process } = { process };
  runInNewContext(emitted, context);
  const guest = context.factory?.(internal);
  if (!guest) throw new Error("Missing process factory result");
  Object.assign(guest, { observedStderr: stderr });
  return guest as GuestProcess & { observedStderr: string[] };
}

async function exercise(process: GuestProcess & { observedStderr?: string[] }) {
  const warnings: WarningEvent[] = [];
  const hadOwnProperty = Object.hasOwn(process, "noDeprecation");
  const previous = process.noDeprecation;
  const listener = (warning: WarningEvent) => warnings.push(warning);
  try {
    process.on("warning", listener);
    process.noDeprecation = true;
    process.emitWarning("hidden", "DeprecationWarning");
    process.emitWarning("other", "OtherWarning");
    process.noDeprecation = false;
    process.emitWarning("shown", "DeprecationWarning");
    await new Promise(resolve => setImmediate(resolve));
    return { warnings, stderr: process.observedStderr ?? [] };
  } finally {
    process.off("warning", listener);
    if (hadOwnProperty) process.noDeprecation = previous;
    else delete process.noDeprecation;
  }
}

test("noDeprecation suppresses only deprecation warnings while set", async () => {
  expect(await exercise(loadCurrent())).toEqual(await exercise(process));
});

test("native oracle restores listeners and property presence after delivery", async () => {
  const previous = process.noDeprecation;
  const hadOwnProperty = Object.hasOwn(process, "noDeprecation");
  const listeners = process.listenerCount("warning");
  try {
    delete process.noDeprecation;
    await exercise(process);
    expect(Object.hasOwn(process, "noDeprecation")).toBe(false);
    expect(process.listenerCount("warning")).toBe(listeners);
  } finally {
    if (hadOwnProperty) process.noDeprecation = previous;
    else delete process.noDeprecation;
  }
});

test("other warning types and re-enabling remain observable", async () => {
  const result = await exercise(loadCurrent());
  expect(result.warnings.map(warning => warning.message)).toEqual(["other", "shown"]);
  expect(result.warnings.map(warning => warning.name)).toEqual(["OtherWarning", "DeprecationWarning"]);
});
