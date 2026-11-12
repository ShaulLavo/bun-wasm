import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectChecks } from "./test-checks";

const wrapper = resolve(import.meta.dir, "with-build-cache.sh");
const cacheFixture = `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s %s\\n' "$1" "$SCCACHE_SERVER_UDS" "$SCCACHE_IDLE_TIMEOUT" >> "$CACHE_EVENTS"
case "$1" in
  --start-server)
    if [[ \${CACHE_START_FAIL:-0} == 1 ]]; then exit 71; fi
    "$CACHE_FIXTURE_BUN" -e 'const server = require("node:net").createServer(); server.listen(process.argv[1]); server.unref();' "$SCCACHE_SERVER_UDS"
    if [[ \${CACHE_START_SIGNAL:-0} == 1 ]]; then kill -TERM "$PPID"; fi
    ;;
  --stop-server)
    if [[ ! -S $SCCACHE_SERVER_UDS ]]; then echo "couldn't connect to server" >&2; exit 1; fi
    rm -- "$SCCACHE_SERVER_UDS"
    echo 'Compile requests 0'
    exit "\${CACHE_STOP_STATUS:-0}"
    ;;
  --check-live)
    [[ -S $SCCACHE_SERVER_UDS && $SCCACHE_IDLE_TIMEOUT == 3600 ]]
    ;;
  *) exit 72 ;;
esac
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sc-"));
  for (const path of ["bin", "sockets", "cache"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "bin/sccache"), cacheFixture, { mode: 0o755 });
  writeFileSync(join(root, "events"), "");
  const env = {
    ...process.env, CARGO_HOME: root, SCCACHE_SOCKET_ROOT: join(root, "sockets"),
    SCCACHE_DIR: join(root, "cache"), CACHE_EVENTS: join(root, "events"), CACHE_FIXTURE_BUN: process.execPath,
    BUILD_CACHE: "1", RUSTC_WRAPPER: "sccache", SCCACHE_IDLE_TIMEOUT: "1",
    SCCACHE_SERVER_UDS: join(root, "outer-server"),
    CMAKE_C_COMPILER_LAUNCHER: "custom-c", CMAKE_CXX_COMPILER_LAUNCHER: "custom-cxx",
  };
  return { root, env };
}

function run(env: NodeJS.ProcessEnv, command: string[], timeoutSeconds?: string) {
  const args = [wrapper].concat(command);
  const executable = timeoutSeconds ? "timeout" : "bash";
  const argv = timeoutSeconds ? ["--kill-after=2s", timeoutSeconds, "bash"].concat(args) : args;
  const result = Bun.spawnSync([executable].concat(argv), { env, detached: true, timeout: 5000 });
  try {
    if (result.exitedDueToTimeout) throw new Error("Cache control timed out");
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    stopGroup(result.pid);
  }
}

function stopGroup(pid: number): void {
  if (pid <= 1) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function events(root: string): string[][] {
  return readFileSync(join(root, "events"), "utf8").trim().split("\n").filter(Boolean).map(line => line.split(" "));
}

function expectStopped(root: string): void {
  expect(readdirSync(join(root, "sockets"))).toEqual([]);
  const calls = events(root);
  expect(calls.map(call => call[0])).toEqual(["--start-server", "--check-live", "--stop-server"]);
  expect(new Set(calls.map(call => call[1])).size).toBe(1);
  expect(calls.every(call => call[2] === "3600")).toBe(true);
}

test("quality owns the build cache lifecycle regression", () => {
  expect(selectChecks("quality")).toContain("scripts/with-build-cache.test.ts");
});

test.each([0, 23])("cache startup and teardown preserve command exit %s and launcher settings", status => {
  const { root, env } = fixture();
  try {
    const result = run(env, ["bash", "-c", 'sccache --check-live; [[ $RUSTC_WRAPPER == */scripts/rustc-cache.sh && $CMAKE_C_COMPILER_LAUNCHER == custom-c && $CMAKE_CXX_COMPILER_LAUNCHER == custom-cxx && $SCCACHE_DIR == "$CARGO_HOME/cache" ]] || exit 99; exit "$1"', "probe", String(status)]);
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toBe("");
    expectStopped(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commands without compiler requests still have truthful zero-request stats", () => {
  const { root, env } = fixture();
  try {
    const result = run(env, ["true"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Compile requests 0");
    expect(events(root).map(call => call[0])).toEqual(["--start-server", "--stop-server"]);
    expect(readdirSync(join(root, "sockets"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed startup never runs the workload or attempts phantom shutdown", () => {
  const { root, env } = fixture();
  try {
    const result = run({ ...env, CACHE_START_FAIL: "1" }, ["bash", "-c", "echo workload"]);
    expect(result.status).toBe(71);
    expect(result.stdout).not.toContain("workload");
    expect(result.stderr).toBe("");
    expect(events(root).map(call => call[0])).toEqual(["--start-server"]);
    expect(readdirSync(join(root, "sockets"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("disabled caching runs the command without a private server", () => {
  const { root, env } = fixture();
  try {
    const result = run({ ...env, BUILD_CACHE: "0", RUSTC_WRAPPER: "custom-rust" }, ["bash", "-c", '[[ $RUSTC_WRAPPER == custom-rust && $SCCACHE_SERVER_UDS == "$CARGO_HOME/outer-server" ]] || exit 99; exit 24']);
    expect(result.status).toBe(24);
    expect(events(root)).toEqual([]);
    expect(readdirSync(join(root, "sockets"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an explicit Rust wrapper remains selected", () => {
  const { root, env } = fixture();
  try {
    const result = run({ ...env, RUSTC_WRAPPER: "custom-rust" }, ["bash", "-c", 'sccache --check-live; [[ $RUSTC_WRAPPER == custom-rust ]]']);
    expect(result.status, result.stderr).toBe(0);
    expectStopped(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([0, 23])("a shutdown failure does not replace workload status %s", status => {
  const { root, env } = fixture();
  try {
    const result = run({ ...env, CACHE_STOP_STATUS: "74" }, ["bash", "-c", `sccache --check-live; exit ${status}`]);
    expect(result.status).toBe(status);
    expectStopped(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([{ signal: "INT", status: 130 }, { signal: "TERM", status: 143 }])("$signal runs cache cleanup once", ({ signal, status }) => {
  const { root, env } = fixture();
  try {
    const result = run(env, ["bash", "-c", `sccache --check-live; kill -${signal} "$PPID"`]);
    expect(result.status, result.stderr).toBe(status);
    expectStopped(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a signal arriving during server startup still cleans its socket", () => {
  const { root, env } = fixture();
  try {
    const result = run({ ...env, CACHE_START_SIGNAL: "1" }, ["bash", "-c", "echo workload"]);
    expect(result.status).toBe(143);
    expect(result.stdout).not.toContain("workload");
    expect(events(root).map(call => call[0])).toEqual(["--start-server", "--stop-server"]);
    expect(readdirSync(join(root, "sockets"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isolated process-group timeout cleans the cache and leaves another session alone", async () => {
  const { root, env } = fixture();
  const sibling = spawn("bash", [wrapper, "bash", "-c", "sccache --check-live; echo ready; read -r; sccache --check-live"], {
    env, detached: true, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
  });
  const closed = once(sibling, "close");
  try {
    await once(sibling.stdout, "data");
    const result = run(env, ["bash", "-c", "sccache --check-live; exec sleep 30"], "0.3s");
    expect(result.status, result.stderr).toBe(124);
    expect(sibling.exitCode).toBeNull();
    expect(readdirSync(join(root, "sockets"))).toHaveLength(1);
    sibling.stdin.end("continue\n");
    expect((await closed)[0]).toBe(0);
    const starts = events(root).filter(call => call[0] === "--start-server");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.[1]).not.toBe(starts[1]?.[1]);
    expect(events(root).filter(call => call[0] === "--stop-server")).toHaveLength(2);
    expect(readdirSync(join(root, "sockets"))).toEqual([]);
  } finally {
    if (sibling.pid !== undefined) stopGroup(sibling.pid);
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
