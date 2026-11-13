import { expect, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";

const code = "function sum(n) { let value = 0; for (let i = 0; i < n; i++) value += i % 7; return value; } console.log(sum(200000)); console.log(process.env.BUN_WASM_SPIDERMONKEY_TIER ?? 'unset');";

function input(name: string, executable = false): string {
  const path = process.env[name];
  if (!path || !isAbsolute(path)) throw new Error(`SpiderMonkey activation requires absolute ${name}`);
  accessSync(path, executable ? constants.X_OK : constants.R_OK);
  return path;
}

for (const tier of [undefined, "interp", "pbl"] as const) {
  test(`SpiderMonkey ${tier ?? "ordinary default"} executes with the expected real PBL entry count`, () => {
    const core = input("SPIDERMONKEY_WASM");
    const launcher = input("BUN_WASM_LAUNCHER", true);
    accessSync(join(dirname(core), "spidermonkey-engine.wasm"), constants.R_OK);
    const env = { ...process.env };
    delete env.BUN_WASM_SPIDERMONKEY_TIER;
    const args = [launcher, "--wasm", core, "--env", "BUN_WASM_SPIDERMONKEY_TRACE=1"];
    if (tier !== undefined) args.push("--env", `BUN_WASM_SPIDERMONKEY_TIER=${tier}`);
    const run = Bun.spawnSync(args.concat(["--", "-e", code]), { env, timeout: 60_000, killSignal: "SIGKILL" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`599994\n${tier ?? "unset"}\n`);
    const stderr = run.stderr.toString();
    const lines = stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const counts = /^bun-wasm spidermonkey: stack_low=0x[0-9a-f]+ stack_high=0x[0-9a-f]+ stack_bytes=[0-9]+(?: register_depth=[0-9]+ entry_depth=[0-9]+)? interrupt_polls=([0-9]+) portable_baseline_entries=([0-9]+)$/.exec(stderr.trimEnd());
    expect(counts).not.toBeNull();
    if (!counts) throw new Error(`Missing real SpiderMonkey tier counts: ${stderr}`);
    expect(Number(counts[1])).toBeGreaterThan(0);
    const entries = Number(counts[2]);
    if (tier === "interp") expect(entries).toBe(0);
    else expect(entries).toBeGreaterThan(0);
    console.log(JSON.stringify({ tier: tier ?? "default", trace: stderr.trimEnd() }));
  }, 65_000);
}
