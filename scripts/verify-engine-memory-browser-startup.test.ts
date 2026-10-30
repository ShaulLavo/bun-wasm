import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, mock, spyOn, test } from "bun:test";

class StartupServer extends childProcess.ChildProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode = null;
  pid = 0;
  kill() {
    this.exitCode = 0;
    this.emit("close");
    return true;
  }
}

function installStartupControls(): void {
  const server = new StartupServer();
  server.stdout.write("at http://127.0.0.1:1\n");
  spyOn(childProcess, "spawn").mockReturnValue(server);
  let connected = true;
  const page = {
    on() {},
    addInitScript(_observer: unknown, options: unknown) {
      assert.deepEqual(options, {
        engine: "quickjs", executable: "/opt/bun/quickjs/bin/bun",
        paths: ["/home/user/memory-producer.ts", "/home/user/memory-parent.ts", "/home/user/memory-child.ts"],
      });
      throw new Error("Startup reached initialized observer fixtures");
    },
  };
  const browser = {
    newContext: async () => ({ newPage: async () => page, close: async () => {} }),
    close: async () => { connected = false; },
    isConnected: () => connected,
  };
  mock.module("playwright", () => ({ chromium: { launch: async () => browser } }));
}

if (process.env.BUN_WASM_MEMORY_STARTUP_CONTROL === "1") installStartupControls();
else test("memory browser CLI initializes fixture paths before installing its observer", () => {
  const output = mkdtempSync(join(tmpdir(), "bun-wasm-memory-startup-"));
  try {
    const result = Bun.spawnSync([process.execPath, "--preload", import.meta.filename,
      join(import.meta.dir, "verify-engine-memory-browser.ts"), output], {
      env: { ...process.env, BUN_WASM_MEMORY_STARTUP_CONTROL: "1" },
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Startup reached initialized observer fixtures");
    expect(result.stderr.toString()).not.toContain("before initialization");
    expect(JSON.parse(readFileSync(join(output, "hook-cleanup.json"), "utf8"))).toEqual({
      serverPid: 0, serverExited: true, browserClosed: true,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
