import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wasm } from "../tests/package/guest-receipt-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { hash, guestBuilds } from "./guest-source-manifest";
import type { BrowserGuestSelection } from "./browser-guest-catalogue";
import { verifyBrowserGuestCoverage } from "./browser-guest-coverage";

const root = resolve(import.meta.dir, "..");
export function fixtureFile(directory: string, path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), bytes);
}
export async function coverageFixture(cleanup: Set<string>, selection: BrowserGuestSelection) {
  const directory = mkdtempSync("/work/tmp/bun-wasm-coverage-");
  cleanup.add(directory); // Registered before creating fixture files or preparing anything.
  const out = join(directory, "artifact"), site = join(out, "site");
  const maps: Record<string, string> = {};
  for (const build of ["browser", "quickjs", "jsc", "tools"] as const) {
    const pair = build === "quickjs" || build === "jsc" ? quickjsPair(build) : undefined;
    const bytes = pair?.core ?? wasm;
    const name = guestBuilds[build].artifact;
    fixtureFile(out, "site/" + name + ".gz", Bun.gzipSync(bytes));
    maps[name] = hash(bytes);
    if (pair) {
      const side = build === "quickjs" ? "quickjs.wasm" : "jsc-engine.wasm";
      fixtureFile(out, "site/" + side + ".gz", Bun.gzipSync(pair.side));
      maps[side] = hash(pair.side);
    }
  }
  fixtureFile(out, "site/engine-builds.json", JSON.stringify(maps));
  fixtureFile(out, "site/index.html", `globalThis.__bunwasmBuilds=${JSON.stringify(maps)};`);
  fixtureFile(out, "site/sandbox/bun-browser.wasm.gz", Bun.gzipSync(wasm));
  fixtureFile(out, "site/sandbox/engine-builds.json", JSON.stringify({ "bun-browser.wasm": hash(wasm) }));
  for (const name of ["main.js", "sw.js", "worker.js", "fs-worker.js", "notification-worker.js", "preview1-worker.js"]) fixtureFile(site, name, "fixture, never executed");
  for (const name of ["shell-engine.wasm", "env.wasm"]) fixtureFile(site, "programs/" + name, wasm);
  const { basePrograms }: typeof import("waffle-base") = await import(Bun.resolveSync("waffle-base", join(root, "web")));
  for (const program of basePrograms) {
    if (!program.wasm) continue;
    const path = fileURLToPath(program.wasm), family = basename(resolve(dirname(path), ".."));
    fixtureFile(site, `programs/base/${family}/dist/${basename(path)}`, readFileSync(path));
  }
  if (selection.some(item => item.owner === "engine-interruption")) {
    for (const name of ["index.html", "engine-interruption-page.js", "engine-interruption-worker.js", "worker.js", "fs-worker.js", "notification-worker.js", "preview1-worker.js"]) fixtureFile(out, "interruption/" + name, "synthetic bundle, never executed");
  }
  return { out, site, prepare: () => verifyBrowserGuestCoverage({ out, selection }) };
}
