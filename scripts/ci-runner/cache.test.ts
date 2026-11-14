import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";

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

test.each([
  { name: "exact", key: "native-main-first", prefixes: "", paths: "target", matched: "native-main-first", hit: true },
  { name: "ordered prefix", key: "native-main-next", prefixes: "wrong-\nnative-main-", paths: "target", matched: "native-main-first", hit: false },
  { name: "exact-only miss", key: "native-main-next", prefixes: "", paths: "target", matched: "", hit: false },
  { name: "unmatched prefix", key: "unpublished", prefixes: "wrong-", paths: "target", matched: "", hit: false },
  { name: "different paths", key: "native-main-first", prefixes: "native-main-", paths: "target/*", matched: "", hit: false },
])("lookup-only reports $name without changing existing or absent targets", ({ key, prefixes, paths, matched, hit }) => {
  const f = fixture();
  expect(f.run("save").status).toBe(0);
  writeFileSync(`${f.workspace}/target/stamp`, "consumer-owned bytes");
  const timestamp = statSync(`${f.workspace}/target/stamp`, { bigint: true }).mtimeNs;
  const inputs = { CACHE_LOOKUP_ONLY: "true", CACHE_KEY: key, CACHE_RESTORE_KEYS: prefixes, CACHE_PATHS: paths };
  const present = f.run("restore", inputs);
  expect(present.status, present.stderr).toBe(0);
  expect(present.output).toBe(`cache-hit=${hit}\ncache-matched-key=${matched}\n`);
  expect(readdirSync(`${f.workspace}/target`).sort()).toEqual(["link", "stamp"]);
  expect(readFileSync(`${f.workspace}/target/stamp`, "utf8")).toBe("consumer-owned bytes");
  expect(statSync(`${f.workspace}/target/stamp`, { bigint: true }).mtimeNs).toBe(timestamp);
  expect(readlinkSync(`${f.workspace}/target/link`)).toBe("stamp");
  rmSync(`${f.workspace}/target`, { recursive: true });
  const absent = f.run("restore", inputs);
  expect(absent.status, absent.stderr).toBe(0);
  expect(absent.output).toBe(present.output);
  expect(existsSync(`${f.workspace}/target`)).toBe(false);
});

test("lookup-only uses absolute temporary paths and leaves archive verification to the real restore", () => {
  const f = fixture();
  const prebuild = `${f.env.RUNNER_TEMP}/jsc/prebuild`;
  mkdirSync(prebuild, { recursive: true });
  writeFileSync(`${prebuild}/stamp`, "published");
  const inputs = { CACHE_PATHS: prebuild };
  expect(f.run("save", inputs).status).toBe(0);
  const directory = `${f.directory}/cache/snapshots-v1`;
  const entry = readdirSync(directory)[0];
  writeFileSync(`${directory}/${entry}/snapshot.tar.zst`, "unread archive bytes");
  rmSync(prebuild, { recursive: true });
  const lookup = f.run("restore", { ...inputs, CACHE_LOOKUP_ONLY: "true" });
  expect(lookup.status, lookup.stderr).toBe(0);
  expect(lookup.output).toBe("cache-hit=true\ncache-matched-key=native-main-first\n");
  expect(existsSync(prebuild)).toBe(false);
  const restore = f.run("restore", { ...inputs, CACHE_LOOKUP_ONLY: "false" });
  expect(restore.status).toBe(1);
  expect(restore.output).toBe("");
  expect(restore.stderr).toContain("Corrupt cache archive");
  expect(existsSync(prebuild)).toBe(false);
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

test.each(["false", "true"])("restore with lookup-only=%s retains the least recently used snapshot policy", lookupOnly => {
  const f = fixture();
  expect(f.run("save", { CACHE_KEY: "slot-1" }).status).toBe(0);
  expect(f.run("save", { CACHE_KEY: "slot-2" }).status).toBe(0);
  const directory = `${f.directory}/cache/snapshots-v1`;
  const entries = readdirSync(directory).map(entry => `${directory}/${entry}`);
  const snapshots = entries.map(path => ({ path, key: snapshotKey(path) }));
  for (const entry of snapshots) utimesSync(entry.path, 1, entry.key === "slot-1" ? 1 : 2);
  const bytes = entries.reduce((sum, path) => sum + statSync(`${path}/snapshot.tar.zst`).size + statSync(`${path}/snapshot.json`).size, 32);
  expect(f.run("restore", { CACHE_KEY: "slot-1", CACHE_LOOKUP_ONLY: lookupOnly }).status).toBe(0);
  expect(f.run("save", { CACHE_KEY: "slot-3", BUN_WASM_PC_CACHE_MAX_BYTES: String(bytes) }).status).toBe(0);
  const keys = readdirSync(directory).map(entry => snapshotKey(`${directory}/${entry}`)).sort();
  expect(keys).toEqual(["slot-1", "slot-3"]);
  expect(f.run("restore", { CACHE_KEY: "slot-1" }).output).toContain("cache-hit=true");
  expect(f.run("restore", { CACHE_KEY: "slot-2" }).output).toBe("cache-hit=false\ncache-matched-key=\n");
});

test("empty lookup reclaims interrupted staging without creating a restore target", () => {
  const f = fixture();
  const directory = `${f.directory}/cache/snapshots-v1`;
  mkdirSync(`${directory}/.saving-stale`, { recursive: true });
  writeFileSync(`${directory}/.saving-stale/partial.tar.zst`, "partial");
  rmSync(`${f.workspace}/target`, { recursive: true });
  const lookup = f.run("restore", { CACHE_LOOKUP_ONLY: "true" });
  expect(lookup.status, lookup.stderr).toBe(0);
  expect(lookup.output).toBe("cache-hit=false\ncache-matched-key=\n");
  expect(readdirSync(directory)).toEqual([]);
  expect(existsSync(`${f.workspace}/target`)).toBe(false);
});

test("invalid lookup metadata fails without outputs or target writes and releases the lock", () => {
  const f = fixture();
  expect(f.run("save").status).toBe(0);
  const directory = `${f.directory}/cache/snapshots-v1`;
  const entry = `${directory}/${readdirSync(directory)[0]}`;
  writeFileSync(`${entry}/snapshot.json`, "{}");
  rmSync(`${f.workspace}/target`, { recursive: true });
  const failed = f.run("restore", { CACHE_LOOKUP_ONLY: "true" });
  expect(failed.status).toBe(1);
  expect(failed.output).toBe("");
  expect(failed.stderr).toContain("Invalid cache metadata");
  expect(existsSync(`${f.workspace}/target`)).toBe(false);
  rmSync(entry, { recursive: true });
  const next = f.run("restore", { CACHE_LOOKUP_ONLY: "true" });
  expect(next.status, next.stderr).toBe(0);
  expect(next.output).toBe("cache-hit=false\ncache-matched-key=\n");
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
