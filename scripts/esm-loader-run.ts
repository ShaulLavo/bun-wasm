// Runs every tests/fixtures/esm-loader case through the loader on a script
// engine and diffs its output with Node's (expected.txt). Usage:
//   bun scripts/esm-loader-run.ts [engine command…]   (default: bun)
//   bun scripts/esm-loader-run.ts /work/tmp/hermes-esm-build/host/bin/hermes -Xmicrotask-queue
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureCases, fixturesDir, harnessSource, loaderSource } from "./esm-loader-harness";

export function runCase(name: string, engine: string[], scratch: string, loader = loaderSource()) {
  const script = join(scratch, `${name}.js`);
  writeFileSync(script, harnessSource(name, loader));
  const [command, ...args] = engine;
  const run = spawnSync(command!, args.concat(script), { encoding: "utf8", timeout: 30_000 });
  const expected = readFileSync(join(fixturesDir, name, "expected.txt"), "utf8");
  return { name, ok: run.stdout === expected, actual: run.stdout + run.stderr, expected };
}

function runAll(engine: string[]): number {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "bun-wasm-esm-run-"));
  const loader = loaderSource();
  try {
    const results = fixtureCases().map(name => runCase(name, engine, scratch, loader));
    for (const result of results) {
      console.log(`${result.ok ? "pass" : "FAIL"} ${result.name}`);
      if (!result.ok) console.log(`--- expected\n${result.expected}--- actual\n${result.actual}`);
    }
    const passed = results.filter(result => result.ok).length;
    console.log(`${passed}/${results.length} cases match Node`);
    return results.length - passed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const engine = process.argv.length > 2 ? process.argv.slice(2) : ["bun"];
  process.exit(runAll(engine) === 0 ? 0 : 1);
}
