import { expect, test } from "bun:test";
import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalSession,
} from "waffle/browser/runtime-terminals";
import type { RuntimeWorkerRequest } from "waffle/browser/worker";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { attachBunTerminal } from "../src/bun-terminal";

function must<T>(result: { kind: "ok"; value: T } | { kind: "error"; code: string }): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

// The shell's side, as Waffle's own terminal-input tests set it up: a session whose foreground
// group holds this process, and the input buffer the page pushes keys into.
function foregroundTerminal() {
  const process = createWorkerProcessTransport({ capacity: 8 });
  const input = createTerminalInput({ capacity: 64 });
  const display = createTerminalSession({ controller: process, geometry: { columns: 80, rows: 24 } });
  const policy = { tryRead: () => -6, inputReadiness: () => ({ readable: false, nbytes: 0 }), transition: () => ({ kind: "ok" as const, value: undefined }), tryWrite: () => 0, outputReadiness: () => ({ writable: true }) };
  const authority = must(claimTerminalAuthority({ identity: display.identity, process, checkActive() {}, policy }));
  const group = must(authority.createGroup({ initialMode: "raw" }));
  must(authority.admitExisting({ group, pid: process.pid }));
  must(authority.acquire({ group, expected: null }));
  const request = (data: unknown) => ({ runtimeProcess: Object.assign(process, { data }) }) as unknown as RuntimeWorkerRequest;
  return { input, display, request };
}

test("stdin reads the foreground terminal's keys; stdout and stderr keep the default stream", () => {
  const { input, display, request } = foregroundTerminal();
  const terminal = attachBunTerminal(request({ terminalContext: display.inherit(), terminalInput: input.buffer }), () => {});
  try {
    const stdin = terminal!.resolve(0)!;
    const bytes = new Uint8Array(8);
    expect(stdin.tryRead?.([bytes])).toBe(-6);
    expect(input.push(new TextEncoder().encode("1+2\r"))).toBe(4);
    expect(stdin.tryRead?.([bytes])).toBe(4);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("1+2\r");
    expect(terminal!.resolve(1)).toBeUndefined();
    expect(terminal!.resolve(2)).toBeUndefined();
    expect(terminal!.setRawMode(false)).toBeUndefined();
    expect(input.push(new TextEncoder().encode("ab\r"))).toBe(3);
    expect(stdin.tryRead?.([bytes])).toBe(3);
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe("ab\n");
    expect(terminal!.setRawMode(true)).toBeUndefined();
    const inherited = terminal!.spawnData();
    expect(inherited.terminalInput).toBe(input.buffer);
    expect(inherited.terminalContext).toBeDefined();
  } finally {
    terminal!.dispose();
    display.close("disposed");
  }
});

test("without terminal metadata stdin stays an ordinary descriptor; partial metadata fails the start", () => {
  const { input, display, request } = foregroundTerminal();
  try {
    expect(attachBunTerminal(request(undefined), () => {})).toBeUndefined();
    expect(attachBunTerminal(request({ filesystem: {} }), () => {})).toBeUndefined();
    expect(() => attachBunTerminal(request({ terminalInput: input.buffer }), () => {})).toThrow(TypeError);
    expect(() => attachBunTerminal(request({ terminalContext: display.inherit() }), () => {})).toThrow(TypeError);
    expect(() => attachBunTerminal(request({ terminalContext: display.inherit(), terminalInput: new ArrayBuffer(64) }), () => {})).toThrow(TypeError);
    expect(() => attachBunTerminal(request({ terminalContext: {}, terminalInput: input.buffer }), () => {})).toThrow();
  } finally {
    display.close("disposed");
  }
});
