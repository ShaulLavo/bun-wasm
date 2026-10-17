// Run real Bun guests through the native Node runtime_proc host, not a host-specific spawn API.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM || fileURLToPath(new URL("../../dist/bun-browser.wasm", import.meta.url));
const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? tmpdir(), "bun-wasm-self-spawn-browser-"));
try {
  mkdirSync(`${scratch}/nested`);
  writeFileSync(`${scratch}/nested/value.txt`, "cwd contents");
  const code = `
    const assert = require("node:assert/strict");
    const text = value => new TextDecoder().decode(value);
    const run = (source, options = {}) => Bun.spawnSync(["bun", "-e", source], { cwd: "/", env: { CHILD_VALUE: "fresh" }, stdout: "pipe", stderr: "pipe", ...options });
    const first = Bun.spawnSync(["bun", "-e", 'console.log(process.env.CHILD_VALUE, process.cwd(), process.argv.at(-1)); console.error("err"); process.exit(7)', "argument"], { cwd: "/", env: { CHILD_VALUE: "fresh" }, stdout: "pipe", stderr: "pipe" });
    assert.equal(first.exitCode, 7); assert.equal(text(first.stdout), "fresh / argument\\n"); assert.equal(text(first.stderr), "err\\n");
    const cwd = run('console.log(process.cwd(), require("node:fs").readFileSync("value.txt","utf8"))', { cwd: "/nested" });
    assert.equal(cwd.exitCode, 0); assert.equal(text(cwd.stdout), "/nested cwd contents\\n");
    const input = run('console.log(require("node:fs").readFileSync(0,"utf8"))', { stdin: new TextEncoder().encode("input text") });
    assert.equal(input.exitCode, 0); assert.equal(text(input.stdout), "input text\\n");
    assert.equal(run('require("node:fs").writeFileSync("/shared.txt", "shared")').exitCode, 0);
    const large = run('process.stdout.write("x".repeat(1200000))'); assert.equal(large.exitCode, 0); assert.equal(large.stdout.length, 1200000);
    assert.equal(run('console.log("inherited"); console.error("ignored")', { stdout: "inherit", stderr: "ignore" }).exitCode, 0);
    const infinite = Bun.spawn(["bun", "-e", "while(true){}"], { stdout: "pipe", stderr: "pipe" });
    infinite.kill(9); assert.equal(await infinite.exited, 137);
    // Generic process identities replace the old global four-child slots. Concurrent fresh
    // guests must all be independently killable; no reused slot can target a replacement.
    const children = Array.from({length: 4}, () => Bun.spawn(["bun", "-e", "while(true){}"], { stdout: "pipe", stderr: "pipe" }));
    assert.equal(new Set(children.map(child => child.pid)).size, 4);
    for (const child of children) child.kill(9);
    for (const child of children) assert.equal(await child.exited, 137);
    const missing = Bun.spawnSync(["/bin/sh", "-c", "true"], { stdout: "pipe", stderr: "pipe" }); assert.equal(missing.exitCode, 127);
    console.log("9 subprocess worker checks passed");
  `;
  const child = spawnSync("node", ["--no-warnings", fileURLToPath(new URL("../scripts/node-host.mjs", import.meta.url)), "--wasm", wasm, "--dir", `${scratch}::/`, "--", "-e", code], { encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  assert.equal(child.stdout, "inherited\n9 subprocess worker checks passed\n");
  assert.equal(readFileSync(`${scratch}/shared.txt`, "utf8"), "shared");
  console.log("9 subprocess worker checks passed");
} finally { rmSync(scratch, { recursive: true, force: true }); }
