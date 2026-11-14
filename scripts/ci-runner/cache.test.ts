import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-pc-cache-"));
  scratch.push(directory);
  const workspace = `${directory}/workspace`;
  mkdirSync(`${workspace}/target`, { recursive: true });
  mkdirSync(`${directory}/temp`);
  writeFileSync(`${workspace}/target/stamp`, "unchanged source identity\n");
  symlinkSync("stamp", `${workspace}/target/link`);
  const env = { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: `${directory}/temp`, BUN_WASM_PC_CACHE_ROOT: `${directory}/cache`, CACHE_PATHS: "target", CACHE_KEY: "native-main-first", CACHE_RESTORE_KEYS: "", GITHUB_OUTPUT: `${directory}/output`, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "ShaulLavo/bun-wasm" };
  function run(operation: "restore" | "save", overrides: NodeJS.ProcessEnv = {}) {
    writeFileSync(env.GITHUB_OUTPUT, "");
    const result = spawnSync("node", [new URL("./cache.ts", import.meta.url).pathname, operation], { env: { ...env, ...overrides }, encoding: "utf8" });
    return { ...result, output: readFileSync(env.GITHUB_OUTPUT, "utf8") };
  }
  return { directory, workspace, env, run };
}

function snapshotKey(path: string): string {
  const snapshot: unknown = JSON.parse(readFileSync(`${path}/snapshot.json`, "utf8"));
  if (typeof snapshot !== "object" || snapshot === null || !("key" in snapshot) || typeof snapshot.key !== "string") throw new Error("Missing snapshot key");
  return snapshot.key;
}

test("real Node cache round trip preserves stamps, times and links; saves are immutable", () => {
  const f = fixture();
  const timestamp = statSync(`${f.workspace}/target/stamp`, { bigint: true }).mtimeNs;
  expect(f.run("restore").output).toBe("cache-hit=false\ncache-matched-key=\n");
  expect(f.run("save").status).toBe(0);
  writeFileSync(`${f.workspace}/target/stamp`, "changed");
  expect(f.run("save").status).toBe(0);
  rmSync(`${f.workspace}/target`, { recursive: true });
  const restored = f.run("restore");
  expect(restored.status).toBe(0);
  expect(restored.output).toContain("cache-hit=true\ncache-matched-key=native-main-first\n");
  expect(readFileSync(`${f.workspace}/target/link`, "utf8")).toBe("unchanged source identity\n");
  expect(statSync(`${f.workspace}/target/stamp`, { bigint: true }).mtimeNs).toBe(timestamp);
});

test("ordered prefix fallback and globs retain original matched key", () => {
  const f = fixture();
  expect(f.run("save", { CACHE_PATHS: "target/*" }).status).toBe(0);
  rmSync(`${f.workspace}/target`, { recursive: true });
  const result = f.run("restore", { CACHE_PATHS: "target/*", CACHE_KEY: "native-main-second", CACHE_RESTORE_KEYS: "wrong-\nnative-main-" });
  expect(result.status).toBe(0);
  expect(result.output).toBe("cache-hit=false\ncache-matched-key=native-main-first\n");
  expect(readFileSync(`${f.workspace}/target/stamp`, "utf8")).toContain("unchanged");
});

test("recursive directory snapshot honors excluded paths", () => {
  const f = fixture();
  const patterns = "target\n!target/stamp\n!target/link";
  writeFileSync(`${f.workspace}/target/keep`, "keep");
  expect(f.run("save", { CACHE_PATHS: patterns }).status).toBe(0);
  rmSync(`${f.workspace}/target`, { recursive: true });
  expect(f.run("restore", { CACHE_PATHS: patterns }).status).toBe(0);
  expect(readdirSync(`${f.workspace}/target`)).toEqual(["keep"]);
});

test("corruption fails before touching work; PR saves and outside paths fail closed", () => {
  const f = fixture();
  expect(f.run("save", { GITHUB_EVENT_NAME: "pull_request" }).status).toBe(1);
  expect(f.run("save", { CACHE_PATHS: "/home/shaul/.config/gh" }).status).toBe(1);
  expect(f.run("save").status).toBe(0);
  const snapshots = `${f.directory}/cache/snapshots-v1`;
  const entry = readdirSync(snapshots)[0];
  writeFileSync(`${snapshots}/${entry}/snapshot.tar.zst`, "broken");
  const result = f.run("restore");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Corrupt cache archive");
  expect(readFileSync(`${f.workspace}/target/stamp`, "utf8")).toContain("unchanged");
});

test("portable fixtures retain absolute private storage and job-path boundaries", () => {
  const f = fixture();
  expect(f.run("save", { BUN_WASM_PC_CACHE_ROOT: "/" }).status).toBe(1);
  expect(f.run("save", { BUN_WASM_PC_CACHE_ROOT: "relative-cache" }).status).toBe(1);
  expect(f.run("save", { BUN_WASM_PC_CACHE_ROOT: `${f.workspace}/cache` }).status).toBe(1);
  expect(f.run("save", { CACHE_PATHS: f.workspace }).status).toBe(1);
  symlinkSync(f.directory, `${f.workspace}/escape`);
  expect(f.run("save", { CACHE_PATHS: "escape/output" }).status).toBe(1);
});

test("retention evicts the least recently used snapshot within the incoming archive budget", () => {
  const f = fixture();
  expect(f.run("save", { CACHE_KEY: "slot-1" }).status).toBe(0);
  expect(f.run("save", { CACHE_KEY: "slot-2" }).status).toBe(0);
  const directory = `${f.directory}/cache/snapshots-v1`;
  const entries = readdirSync(directory).map(entry => `${directory}/${entry}`);
  const snapshots = entries.map(path => ({ path, key: snapshotKey(path) }));
  for (const entry of snapshots) utimesSync(entry.path, 1, entry.key === "slot-1" ? 1 : 2);
  const bytes = entries.reduce((sum, path) => sum + statSync(`${path}/snapshot.tar.zst`).size + statSync(`${path}/snapshot.json`).size, 32);
  expect(f.run("restore", { CACHE_KEY: "slot-1" }).status).toBe(0);
  expect(f.run("save", { CACHE_KEY: "slot-3", BUN_WASM_PC_CACHE_MAX_BYTES: String(bytes) }).status).toBe(0);
  const keys = readdirSync(directory).map(entry => snapshotKey(`${directory}/${entry}`)).sort();
  expect(keys).toEqual(["slot-1", "slot-3"]);
  expect(f.run("restore", { CACHE_KEY: "slot-1" }).output).toContain("cache-hit=true");
  expect(f.run("restore", { CACHE_KEY: "slot-2" }).output).toBe("cache-hit=false\ncache-matched-key=\n");
});

test("interrupted staging is reclaimed and oversized snapshots cannot exceed retention", () => {
  const f = fixture();
  const directory = `${f.directory}/cache/snapshots-v1`;
  mkdirSync(`${directory}/.saving-stale`, { recursive: true });
  writeFileSync(`${directory}/.saving-stale/partial.tar.zst`, "partial");
  expect(f.run("save", { BUN_WASM_PC_CACHE_MAX_BYTES: "1" }).status).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
  expect(f.run("save", { BUN_WASM_PC_CACHE_MAX_BYTES: "34359738369" }).status).toBe(1);
  expect(f.run("save").status).toBe(0);
  expect(readdirSync(directory)).toHaveLength(1);
});

test("a completed Bun dependency snapshot warms a fresh consumer under its original key", () => {
  const f = fixture();
  const cache = `${f.workspace}/.ci-bun-cache`;
  mkdirSync(cache);
  for (const name of ["root-dependency", "web-dependency", "sandbox-dependency"]) writeFileSync(`${cache}/${name}`, name);
  const inputs = { CACHE_PATHS: ".ci-bun-cache", CACHE_KEY: "bun-v2-Linux-locks" };
  expect(f.run("save", inputs).status).toBe(0);
  rmSync(cache, { recursive: true });
  const restored = f.run("restore", { ...inputs, GITHUB_EVENT_NAME: "pull_request" });
  expect(restored.status).toBe(0);
  expect(restored.output).toBe("cache-hit=true\ncache-matched-key=bun-v2-Linux-locks\n");
  expect(readdirSync(cache).sort()).toEqual(["root-dependency", "sandbox-dependency", "web-dependency"]);
});
