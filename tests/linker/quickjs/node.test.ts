import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../../..");
const pair = process.env.BUN_NODE_PAIR;
if (!pair) throw new Error("BUN_NODE_PAIR must name matching qualified core and QuickJS bytes");
const host = join(root, "web/scripts/node-host.mjs");

function run(wasm: string, args: string[], scratch: string) {
  return spawnSync("node", ["--no-warnings", host, "--wasm", wasm, "--"].concat(args), {
    cwd: root, encoding: "utf8", timeout: 20000,
    env: { ...process.env, BUN_WASM_SCRATCH_ROOT: scratch },
  });
}

test("normal Node host starts a matched QuickJS pair and retains it for admitted children", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-node-pair-"));
  try {
    const source = `const child = Bun.spawnSync([process.execPath, '-e', 'console.log(40)'], {stdout:'pipe', stderr:'pipe'});
      if (child.exitCode !== 0 || child.stderr.length) throw Error(child.stderr.toString());
      const value = await Promise.resolve(Number(child.stdout.toString()));
      await new Promise(resolve => setTimeout(resolve, 1)); console.log(value + 2);`;
    const result = run(join(pair, "bun.wasm"), ["-e", source], scratch);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("42\n");
    expect(readdirSync(scratch)).toEqual([]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 25000);

for (const side of ["missing", "core"]) test(`normal Node host rejects a ${side} QuickJS side before entry`, () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-node-pair-"));
  try {
    const wasm = join(scratch, "bun.wasm");
    copyFileSync(join(pair, "bun.wasm"), wasm);
    if (side === "core") copyFileSync(wasm, join(scratch, "quickjs.wasm"));
    const result = run(wasm, ["-e", 'console.log("forbidden")'], scratch);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(side === "missing" ? "quickjs.wasm" : "link quickjs:");
    expect(result.stderr).not.toContain("unreachable");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 25000);
