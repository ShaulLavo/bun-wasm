import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const executable = engine === "native" ? process.env.NATIVE_BUN || "bun" : engine === "browser" ? process.execPath : process.env.BUN_WASM_LAUNCHER!;
  const nativeArgs = args[0] === "x" ? ["x", "--bun"].concat(args.slice(1)) : args;
  // Package scripts run in bash-web's shell guest (scripts/build-bash-web-shell.sh).
  const argv = engine === "native" ? nativeArgs : engine === "browser" ? ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net"].concat(options, args) : ["--shell", resolve(root, "dist/bash-web-shell.wasm"), "--env-utility", resolve(root, "dist/bash-web-env.wasm")].concat(options, args);
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
    const cwd = project("precedence", { "package.json": '{"dependencies":{"tool":"1.0.0"}}', "tool.ts": '#!/usr/bin/env bun\nconsole.log("source-file");' });
    await success(cwd, "install");
    for (const linked of [true, false]) {
      if (!linked) rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
      assert.match(await success(cwd, "run", "tool"), /^source-file\n$/);
      assert.match(await success(cwd, "tool"), /^source-file\n$/);
    }
  },
  async expandedScript() {
    const cwd = project("script", { "package.json": '{"scripts":{"start":"bun src/main"}}', "src/main.ts": '#!/usr/bin/env bun\nconsole.log("expanded-main", process.argv[1].endsWith("/src/main.ts"), import.meta.main);' });
    assert.match(await success(cwd, "run", "start"), /expanded-main true true/);
  },
  async scriptCommandPrecedence() {
    const cwd = project("script-command", {
      "package.json": JSON.stringify({ dependencies: { tool: "1.0.0" }, scripts: { bare: "tool", explicit: "./tool", runtime: "bun tool", node: "node tool", path: "PATH=./tools:$PATH path-tool", override: "PATH=./tools tool" } }),
      tool: '#!/usr/bin/env bun\nconsole.log("source-file");',
      "tools/path-tool": '#!/usr/bin/env bun\nconsole.log("path-bin");',
      "tools/tool": `#!${process.execPath}\nconsole.log("path-bin");`,
      "path-tool.ts": 'throw new Error("cwd source must not run");',
    });
    chmodSync(join(cwd, "tool"), 0o755);
    chmodSync(join(cwd, "tools/path-tool"), 0o755);
    chmodSync(join(cwd, "tools/tool"), 0o755);
    await success(cwd, "install");
    for (const linked of [true, false]) {
      if (!linked) rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
      assert.equal((await success(cwd, "run", "bare")).trim(), "bin-tool");
      for (const name of ["explicit", "runtime", "node", "tool"]) assert.equal((await success(cwd, "run", name)).trim(), "source-file");
      assert.equal((await success(cwd, "run", "path")).trim(), "path-bin");
      assert.equal((await success(cwd, "run", "override")).trim(), "path-bin");
      if (process.env.INSTALL_ENGINE === "native") break;
    }
  },
  async malformedManifestFallback() {
    for (const target of [42, "", "../outside.ts", "/outside.ts"]) {
      const cwd = project(`malformed-${String(target).replaceAll("/", "_")}`, {
        "package.json": '{"dependencies":{"tool":"1.0.0"},"scripts":{"start":"tool"}}',
      });
      await success(cwd, "install");
      project(`malformed-${String(target).replaceAll("/", "_")}`, {
        "node_modules/z-bad/package.json": JSON.stringify({ name: "z-bad", bin: { tool: target } }),
      });
      if (process.env.INSTALL_ENGINE !== "native") rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
      for (const name of ["tool", "start"]) {
        const result = await run(cwd, "run", name);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout.trim(), "bin-tool");
        assert.doesNotMatch(result.stderr, /warn|invalid|malformed/i);
      }
    }
  },
  async binSelection() {
    const cwd = project("bins", { "package.json": '{"dependencies":{"@fixture/multiple":"1.0.0","only":"1.0.0","@fixture/string":"1.0.0"}}' });
    await success(cwd, "install");
    rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
    assert.match(await success(cwd, "x", ...(process.env.INSTALL_ENGINE === "native" ? [] : ["--no-install"]), "@fixture/multiple"), /first-bin/);
    assert.match(await success(cwd, "x", ...(process.env.INSTALL_ENGINE === "native" ? [] : ["--no-install"]), "@fixture/string"), /string-bin/);
    assert.match(await success(cwd, "x", "--no-install", "--package", "@fixture/multiple", "aSecond"), /second-bin/);
    const missing = await run(cwd, "x", "--no-install", "--package", "only", "missing");
    assert.notEqual(missing.code, 0, missing.stdout);
    assert.doesNotMatch(missing.stdout, /only-bin/);
  },
  async invalidBinEntries() {
    const cwd = project("invalid-bin", { "package.json": '{"dependencies":{"invalid-cli":"1.0.0"}}' });
    await success(cwd, "install");
    rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
    assert.match(await success(cwd, "x", ...(process.env.INSTALL_ENGINE === "native" ? [] : ["--no-install"]), "invalid-cli"), /first-valid/);
  },
  async unsetExpansion() {
    const cwd = project("unset", { "package.json": JSON.stringify({ scripts: { check: 'bun args.ts $BUN_WASM_UNSET_VALUE "${BUN_WASM_UNSET_VALUE}"' } }), "args.ts": 'console.log(JSON.stringify(process.argv.slice(2)));' });
    assert.equal((await success(cwd, "run", "check")).trim(), '[""]');
  },
  async warmCache() {
    const cwd = project("cache", { "package.json": '{}' });
    assert.match(await success(cwd, "x", "@fixture/string@1.0.0"), /string-bin/);
    registry.setOffline(true);
    try { assert.match(await success(cwd, "x", "--no-install", "@fixture/string@1.0.0"), /string-bin/); }
    finally { registry.setOffline(false); }
  },
};
try {
  registry = await createRegistry([
    packageFixture("tool", "1.0.0", { bin: "cli.ts" }, undefined, [tarEntry("package/cli.ts", '#!/usr/bin/env bun\nconsole.log("bin-tool");')]),
    packageFixture("@fixture/multiple", "1.0.0", { bin: { zFirst: "first.ts", aSecond: "second.ts" } }, undefined,
      [tarEntry("package/first.ts", '#!/usr/bin/env bun\nconsole.log("first-bin");'), tarEntry("package/second.ts", '#!/usr/bin/env bun\nconsole.log("second-bin");')]),
    packageFixture("invalid-cli", "1.0.0", { bin: { invalid: 42, escape: "../escape.ts", empty: "", zValid: "first.ts", aOther: "second.ts" } }, undefined,
      [tarEntry("package/first.ts", '#!/usr/bin/env bun\nconsole.log("first-valid");'), tarEntry("package/second.ts", '#!/usr/bin/env bun\nconsole.log("second-valid");')]),
    packageFixture("only", "1.0.0", { bin: { actual: "cli.ts" } }, undefined, [tarEntry("package/cli.ts", '#!/usr/bin/env bun\nconsole.log("only-bin");')]),
    packageFixture("@fixture/string", "1.0.0", { bin: "cli.ts" }, undefined, [tarEntry("package/cli.ts", '#!/usr/bin/env bun\nconsole.log("string-bin");')]),
  ]);
  for (const [name, check] of Object.entries(cases)) {
    if (process.env.INSTALL_CASES && !process.env.INSTALL_CASES.split(",").includes(name)) continue;
    try { await check(); console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
  }
} finally { await cleanup(); }
