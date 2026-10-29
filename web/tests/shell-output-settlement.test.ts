import { expect, test } from "bun:test";
import { control, SharedBridge, TerminalNewlines, type PromptWaitOptions } from "bash-web";
import { waitForPrompt } from "../node_modules/bash-web/src/shell-prompt";
import { createRuntime } from "waffle";
import type { Shell } from "../src/shell";

const command = 'exec 9<&-; printf "PIPE_EDITOR_%s\\n" recovered';
const prompt = "user@bun:~$ ";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function heldPump(startupOutput = "") {
  const source = await Bun.file(new URL("../src/shell.ts", import.meta.url)).text();
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source
    .replace(/^import .*;\n/gm, "").replace("export class Shell", "class Shell"));
  const input = Promise.withResolvers<Uint8Array>();
  let terminal: SharedBridge | undefined;
  const createShell = async ({ terminal: bridge }: { terminal: SharedBridge }) => {
    terminal = bridge;
    bridge.connectInput({
      push(bytes) { if (bytes.length) input.resolve(bytes.slice()); return bytes.length; },
      available: () => 0, wake() {}, close() {}, resize() {}, discard: () => true, interrupt() {},
    });
    bridge.write(encoder.encode(startupOutput));
    bridge.publishPrompt(0);
    return { waitForPrompt: (options?: PromptWaitOptions) => waitForPrompt(bridge, options),
      done: new Promise<never>(() => {}), async dispose() {} };
  };
  // Run the actual consumer class and bridge. Only the guest launcher and scheduled pump are held.
  const Session: typeof Shell = new Function("createShell", "SharedBridge", "TerminalNewlines", "control", `${code}; return Shell;`)(createShell, SharedBridge, TerminalNewlines, control);
  Reflect.set(Session.prototype, "pump", () => {});
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL(import.meta.resolve("waffle/browser/fs-worker")) } });
  const output: number[] = [];
  let ready = Promise.withResolvers<void>();
  const readyOutput: string[] = [];
  const session = await Session.create({ runtime, cwd: "/home/user", env: {}, cols: 80, rows: 24,
    wasmUrl: new URL("https://example.test/shell.wasm"), workerUrl: new URL("https://example.test/shell-worker.js"),
    onOutput: bytes => { for (const byte of bytes) output.push(byte); },
    onState: state => { if (state === "ready") { readyOutput.push(decoder.decode(Uint8Array.from(output))); ready.resolve(); } },
  });
  if (!terminal) throw new Error("The shell did not receive a terminal bridge");
  return { session, bridge: terminal, input: input.promise, readyOutput,
    nextReady() { ready = Promise.withResolvers<void>(); return ready.promise; },
    text: () => decoder.decode(Uint8Array.from(output)),
    async dispose() { await session.dispose(); await runtime.dispose(); },
  };
}

test("startup hands off pending output before ready even with the scheduled pump held", async () => {
  const f = await heldPump(prompt);
  try {
    expect(f.readyOutput).toEqual([prompt]);
    expect(f.bridge.drain().length).toBe(0);
  } finally { await f.dispose(); }
});

test.each([0, 7, 130])("submit drains exact output beyond one pump chunk before settling status %i", async status => {
  const f = await heldPump();
  try {
    const done = f.session.submit(command);
    expect(decoder.decode(await f.input)).toBe(`\x05\x15${command}\r`);
    const payload = "x".repeat(65536).concat("\nPIPE_EDITOR_recovered\n", prompt);
    expect(f.bridge.write(encoder.encode(payload))).toBe(encoder.encode(payload).length);
    f.bridge.publishPrompt(status);
    await done;
    expect(f.session.lastExit).toBe(status);
    expect(f.text()).toBe(payload.replaceAll("\n", "\r\n"));
    expect(Atomics.load(f.bridge.state, control.outputRead)).toBe(Atomics.load(f.bridge.state, control.outputWrite));
  } finally { await f.dispose(); }
});

test("keyboard prompt readiness hands off output without a submitted command", async () => {
  const f = await heldPump();
  try {
    f.readyOutput.length = 0;
    const ready = f.nextReady();
    f.bridge.write(encoder.encode("PIPE_EDITOR_recovered\n".concat(prompt)));
    f.bridge.publishPrompt(7);
    await ready;
    expect(f.session.lastExit).toBe(7);
    expect(f.readyOutput).toEqual(["PIPE_EDITOR_recovered\r\n".concat(prompt)]);
  } finally { await f.dispose(); }
});
