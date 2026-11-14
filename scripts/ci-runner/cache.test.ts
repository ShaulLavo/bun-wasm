import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync("/work/tmp/bun-wasm-pc-cache-");
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
