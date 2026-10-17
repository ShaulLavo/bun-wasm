import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRegistry, packageFixture, tarEntry } from "./registry.mjs";

const root = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync("/work/tmp/bun-wasm-install-commands-");
const children = new Set<ReturnType<typeof spawn>>();
let registry: Awaited<ReturnType<typeof createRegistry>>;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const exits = Array.from(children, child => new Promise<void>(resolve => child.once("close", () => resolve())));
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(exits);
  await registry?.close();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));
function project(name: string, files: Record<string, string>) {
  const cwd = join(scratch, name);
  for (const [name, content] of Object.entries(files)) {
    const file = join(cwd, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return cwd;
}
async function run(cwd: string, ...args: string[]) {
  const engine = process.env.INSTALL_ENGINE;
  const env = { ...process.env, HOME: cwd, NPM_CONFIG_REGISTRY: registry.base, BUN_INSTALL_CACHE_DIR: join(cwd, "cache") };
  const options = ["--wasm", resolve(root, process.env.BUN_WASM || "dist/bun.wasm"), "--dir", `${cwd}::/`,
    "--env", "PWD=/", "--env", "HOME=/", "--env", `NPM_CONFIG_REGISTRY=${registry.base}`, "--env", "BUN_INSTALL_CACHE_DIR=/cache", "--"];
  const executable = engine === "native" ? "bun" : engine === "browser" ? process.execPath : process.env.BUN_WASM_LAUNCHER!;
  const argv = engine === "native" ? args : engine === "browser" ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(options, args) : options.concat(args);
  const child = spawn(executable, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout?.on("data", bytes => { stdout += bytes; });
  child.stderr?.on("data", bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); children.delete(child); }
}
async function success(cwd: string, ...args: string[]) {
  const result = await run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}
const cases: Record<string, () => Promise<void>> = {
  async sourcePrecedence() {
    const cwd = project("precedence", { "package.json": '{"dependencies":{"tool":"1.0.0"}}', "tool.ts": 'console.log("source-file");' });
    await success(cwd, "install");
    for (const linked of [true, false]) {
      if (!linked) rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
      assert.match(await success(cwd, "run", "tool"), /^source-file\n$/);
      assert.match(await success(cwd, "tool"), /^source-file\n$/);
    }
  },
  async expandedScript() {
    const cwd = project("script", { "package.json": '{"scripts":{"start":"bun src/main"}}', "src/main.ts": 'console.log("expanded-main", process.argv[1].endsWith("/src/main.ts"), import.meta.main);' });
    assert.match(await success(cwd, "run", "start"), /expanded-main true true/);
  },
  async binSelection() {
    const cwd = project("bins", { "package.json": '{"dependencies":{"@fixture/multiple":"1.0.0","only":"1.0.0","@fixture/string":"1.0.0"}}' });
    await success(cwd, "install");
    rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
    assert.match(await success(cwd, "x", "--no-install", "@fixture/multiple"), /first-bin/);
    assert.match(await success(cwd, "x", "--no-install", "@fixture/string"), /string-bin/);
    assert.match(await success(cwd, "x", "--no-install", "--package", "@fixture/multiple", "second"), /second-bin/);
    const missing = await run(cwd, "x", "--no-install", "--package", "only", "missing");
    assert.notEqual(missing.code, 0, missing.stdout);
    assert.doesNotMatch(missing.stdout, /only-bin/);
  },
  async warmCache() {
    const cwd = project("cache", { "package.json": '{}' });
    assert.match(await success(cwd, "x", "only@1.0.0"), /only-bin/);
    registry.setOffline(true);
    try { assert.match(await success(cwd, "x", "--no-install", "only@1.0.0"), /only-bin/); }
    finally { registry.setOffline(false); }
  },
};
try {
  registry = await createRegistry([
    packageFixture("tool", "1.0.0", { bin: "cli.ts" }, undefined, [tarEntry("package/cli.ts", 'console.log("bin-tool");')]),
    packageFixture("@fixture/multiple", "1.0.0", { bin: { first: "first.ts", second: "second.ts" } }, undefined,
      [tarEntry("package/first.ts", 'console.log("first-bin");'), tarEntry("package/second.ts", 'console.log("second-bin");')]),
    packageFixture("only", "1.0.0", { bin: { actual: "cli.ts" } }, undefined, [tarEntry("package/cli.ts", 'console.log("only-bin");')]),
    packageFixture("@fixture/string", "1.0.0", { bin: "cli.ts" }, undefined, [tarEntry("package/cli.ts", 'console.log("string-bin");')]),
  ]);
  for (const [name, check] of Object.entries(cases)) {
    try { await check(); console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
  }
} finally { await cleanup(); }
