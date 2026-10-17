import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registry as replay } from "../../scripts/app-matrix/registry.mjs";

const root = resolve(import.meta.dir, "../..");
const upstream = join(root, "vendor/bun/test/cli/install/migration");
const scratch = mkdtempSync("/work/tmp/bun-wasm-migration-");
const evidence = process.env.MIGRATION_EVIDENCE;
const children = new Set<ReturnType<typeof spawn>>();
let mirror: Awaited<ReturnType<typeof replay>>;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const exits = Array.from(children, child => new Promise<void>(resolve => child.once("close", () => resolve())));
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(exits);
  await mirror?.close();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
async function run(cwd: string, native: boolean, ...args: string[]) {
  const engine = process.env.INSTALL_ENGINE;
  const options = ["--wasm", resolve(root, process.env.BUN_WASM || "dist/bun.wasm"), "--dir", `${cwd}::/`,
    "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${mirror.base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=2", "--"];
  const executable = native ? process.env.NATIVE_BUN || "/home/shaul/.local/share/mise/installs/bun/1.4.2/bin/bun" : engine === "browser" ? process.execPath : process.env.BUN_WASM_LAUNCHER!;
  const argv = native ? args : engine === "browser" ? [join(root, "web/scripts/node-host.mjs"), "--net"].concat(options, args) : options.concat(args);
  const child = spawn(executable, argv, { cwd, env: { ...process.env, HOME: cwd, BUN_INSTALL_CACHE_DIR: join(cwd, "cache"), NPM_CONFIG_REGISTRY: mirror.base, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout?.on("data", bytes => { output += bytes; });
  child.stderr?.on("data", bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, output };
  } finally { clearTimeout(timer); children.delete(child); }
}
const cases = [
  ["npm", "npm-arborist/dep-installed-without-bin-link"],
  ["classic", "yarn/yarn-lock-mkdirp"],
  ["pnpm", "pnpm/basic"],
  ["pnpm-alias", "pnpm/v9-alias-in-optional-dependencies"],
  ["pnpm-peer-context", "pnpm/v9-peer-range-dedupe"],
  ["pnpm-workspace", "pnpm/v9-importer-peers"],
  ["berry", "yarn-berry/basic"],
  ["berry-workspace", "yarn-berry/workspaces"],
];
try {
  mirror = await replay({ directory: process.env.MATRIX_CACHE || "/work/cache/bun-wasm-app-matrix", record: false });
  for (const [name, source] of cases) {
    if (process.env.MIGRATION_CASES && !process.env.MIGRATION_CASES.split(",").includes(name!)) continue;
    try {
      const reference = join(scratch, `${name}-native`), guest = join(scratch, `${name}-guest`);
      cpSync(join(upstream, source!), reference, { recursive: true });
      cpSync(reference, guest, { recursive: true });
      const native = await run(reference, true, "pm", "migrate");
      const actual = await run(guest, false, "pm", "migrate");
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, `${name}.log`), JSON.stringify({ native, actual }, null, 2));
        for (const [label, directory] of [["native", reference], ["guest", guest]]) {
          if (existsSync(join(directory!, "bun.lock"))) writeFileSync(join(evidence, `${name}-${label}.lock`), readFileSync(join(directory!, "bun.lock")));
        }
      }
      assert.equal(native.code, 0, `native ${name}: ${native.output}`);
      assert.equal(actual.code, 0, `guest ${name}: ${actual.output}`);
      const expected = readFileSync(join(reference, "bun.lock"), "utf8");
      assert.equal(readFileSync(join(guest, "bun.lock"), "utf8"), expected, `${name} differs from native Bun`);
      const frozen = await run(guest, false, "install", "--frozen-lockfile", "--lockfile-only");
      assert.equal(frozen.code, 0, `${name} frozen reinstall: ${frozen.output}`);
      assert.equal(readFileSync(join(guest, "bun.lock"), "utf8"), expected);
      console.log(`PASS ${name}: native bytes and frozen reinstall`);
    } catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ recordedRegistry: mirror.snapshot() }));
} finally { await cleanup(); }
