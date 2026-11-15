import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedBashWeb } from "../../scripts/bash-web-guests.ts";
import { loadNodeShell } from "../scripts/node-shell.ts";
import { claimOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { createNodeProcess, type NodeWasiImports } from "../scripts/node-process.ts";
import { guest } from "../../scripts/fixtures/shared-objects/executor-guest.ts";

function callImport(imports: WebAssembly.Imports, namespace: string, name: string, ...args: number[]) {
  const fn = imports[namespace]?.[name];
  if (typeof fn !== "function") throw new Error(`missing import ${namespace}.${name}`);
  return fn(...args);
}

test("Node shell imports link without memory access and cancellation wins before unsupported permissions", () => {
  const stopped = new Error("shell cancelled");
  const finishes: number[] = [];
  const host = createNodeProcess({ transport: createWorkerProcessTransport({ pid: 99 }), postMessage() {},
    finish(code): never { finishes.push(code); throw stopped; } });
  try {
    const imports: NodeWasiImports = { wasi_snapshot_preview1: { fd_close: () => 0, sock_send: () => 52 } };
    host.install(imports, () => { throw new Error("shell import touched guest memory"); });
    const terminal = imports.shell_terminal!;
    const call = (name: string, ...args: number[]) => callImport(imports, "shell_terminal", name, ...args);
    const permissions = () => callImport(imports, "runtime_fs", "path_permissions_get", -1, -1, -1, -1, -1);
    const entries = Object.keys(terminal).map(name => ({ namespace: "shell_terminal", name }))
      .concat([{ namespace: "runtime_fs", name: "path_permissions_get" }, { namespace: "runtime_proc", name: "inherited_fd" }]);
    expect(() => new WebAssembly.Instance(guest(0, entries), imports)).not.toThrow();
    expect([0, 1, 2, 3, -1].map(fd => call("inherited_fd", fd))).toEqual([0, 1, 2, -1, -1]);
    expect(call("columns")).toBe(80); expect(call("rows")).toBe(24);
    expect(call("prompt_names", -1, -1)).toBe(-1);
    expect(call("prompt", -1, -1, -1, -1, -1)).toBe(-1);
    expect(call("prompt_update", -1, -1, -1)).toBe(-1);
    expect(call("output_position")).toBe(0);
    expect(permissions()).toBe(58);
    claimOutcome(host.client.signals.outcome, { kind: "signaled", code: 15 });
    expect(permissions).toThrow(stopped);
    expect(() => call("inherited_fd", 0)).toThrow(stopped);
    expect(() => callImport(imports, "runtime_proc", "inherited_fd", 0)).toThrow(stopped);
    expect(finishes).toEqual([143, 143, 143]);
  } finally { host.dispose(); }
});

test("Node launch descriptor enumeration snapshots bindings and stdio before preopens", () => {
  const transport = createWorkerProcessTransport();
  transport.resources.push({ kind: "node-stdio", fd: 1 });
  transport.bindings.push({ fd: 91, reference: 0, rightsBase: 64n, rightsInheriting: 0n });
  const host = createNodeProcess({ transport, preopenCount: 4, postMessage() {}, finish(): never { throw new Error("unexpected exit"); } });
  try {
    const imports: NodeWasiImports = { wasi_snapshot_preview1: { fd_close: () => 0, sock_send: () => 52 } };
    const { proc } = host.install(imports, () => { throw new Error("enumeration touched memory"); });
    const snapshot = [0, 1, 2, 3].map(index => proc.inherited_fd!(index));
    expect(snapshot.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 91]);
    expect(proc.inherited_fd!(4)).toBe(-44);
    expect(proc.inherited_fd!(-1)).toBe(-44);
    host.descriptors.close(91);
    expect([0, 1, 2, 3].map(index => proc.inherited_fd!(index))).toEqual(snapshot);
  } finally { host.dispose(); }
});

test("Node loads only a complete matching pinned shell receipt and rejects changed bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-node-shell-"));
  const shell = join(directory, "bash-web-shell.wasm"), env = join(directory, "bash-web-env.wasm");
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const guests = {
    "shell-engine.wasm": { file: "bash-web-shell.wasm", bytes: bytes.length, sha256 },
    "env.wasm": { file: "bash-web-env.wasm", bytes: bytes.length, sha256 },
  };
  const receipt = (bashWeb: string) => writeFileSync(join(directory, "bash-web-guests.json"), JSON.stringify({ bashWeb, rustToolchain: "test", guests }));
  try {
    expect(await loadNodeShell()).toBeUndefined();
    await expect(loadNodeShell(shell)).rejects.toThrow("complete receipt-backed pair");
    writeFileSync(shell, bytes); writeFileSync(env, bytes);
    await expect(loadNodeShell(shell, env)).rejects.toThrow("no bash-web-guests.json");
    receipt("0".repeat(40));
    await expect(loadNodeShell(shell, env)).rejects.toThrow("consumer pins");
    receipt(pinnedBashWeb(join(import.meta.dirname, "..")));
    const loaded = await loadNodeShell(shell, env);
    expect(loaded?.shell).toBeInstanceOf(WebAssembly.Module);
    expect(loaded?.env).toBeInstanceOf(WebAssembly.Module);
    await expect(loadNodeShell(env, shell)).rejects.toThrow("must select the receipt-backed");
    writeFileSync(env, new Uint8Array());
    await expect(loadNodeShell(shell, env)).rejects.toThrow("does not match");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
