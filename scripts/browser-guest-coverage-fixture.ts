import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { hash, guestBuilds } from "./guest-source-manifest";
import { pinnedBashWeb } from "./bash-web-guests";
import { siteInventory } from "./browser-guest-site";
import type { BrowserGuestSelection } from "./browser-guest-catalogue";
import { prepareBrowserGuestCoverage } from "./browser-guest-coverage";

const root = resolve(import.meta.dir, "..");
export function fixtureFile(directory: string, path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), bytes);
}
export async function coverageFixture(cleanup: Set<string>, selection: BrowserGuestSelection) {
  const directory = mkdtempSync("/work/tmp/bun-wasm-coverage-");
  cleanup.add(directory); // Registered before creating fixture files or preparing anything.
  const out = join(directory, "artifact"), dist = join(directory, "dist"), site = join(out, "site");
  const [head, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  if (!head || !tree) throw new Error("Missing fixture source");
  const source = { head, tree }, maps: Record<string, string> = {};
  for (const build of ["browser", "quickjs", "jsc", "tools"] as const) {
    const pair = build === "quickjs" || build === "jsc" ? quickjsPair(build) : undefined;
    const bytes = pair?.core ?? wasm;
    const receipt = fixtureReceipt(bytes, build, pair?.side);
    const sourceManifest = { ...receipt.sourceManifest, source };
    const current = { ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) };
    const name = guestBuilds[build].artifact;
    fixtureFile(dist, name + ".build.json", JSON.stringify(current));
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
  const pin = pinnedBashWeb(join(root, "web"));
  const guests = { "shell-engine.wasm": { file: "bash-web-shell.wasm", bytes: wasm.length, sha256: hash(wasm) },
    "env.wasm": { file: "bash-web-env.wasm", bytes: wasm.length, sha256: hash(wasm) } };
  fixtureFile(dist, "bash-web-guests.json", JSON.stringify({ bashWeb: pin, rustToolchain: "fixture", guests }));
  for (const [name, identity] of Object.entries(guests)) {
    fixtureFile(dist, identity.file, wasm);
    fixtureFile(site, "programs/" + name, wasm);
  }
  const { basePrograms }: typeof import("waffle-base") = await import(Bun.resolveSync("waffle-base", join(root, "web")));
  for (const program of basePrograms) {
    if (!program.wasm) continue;
    const path = fileURLToPath(program.wasm), family = basename(resolve(dirname(path), ".."));
    fixtureFile(site, `programs/base/${family}/dist/${basename(path)}`, readFileSync(path));
  }
  refreshFixtureSite(out);
  if (selection.some(item => item.owner === "engine-interruption")) {
    for (const name of ["index.html", "engine-interruption-page.js", "engine-interruption-worker.js", "worker.js", "fs-worker.js", "notification-worker.js", "preview1-worker.js"]) fixtureFile(out, "interruption/" + name, "synthetic bundle, never executed");
  }
  return { out, dist, site, prepare: () => prepareBrowserGuestCoverage({ out, dist, selection }) };
}
export function refreshFixtureSite(out: string): void {
  const dist = join(dirname(out), "dist");
  const receipt = JSON.parse(readFileSync(join(dist, "bun-browser.wasm.build.json"), "utf8"));
  const compressed = readFileSync(join(out, "site/bun-browser.wasm.gz"));
  fixtureFile(out, "site.json", JSON.stringify({ source: receipt.sourceManifest.source, receipt, guest: { sha256: hash(wasm), bytes: wasm.length, gzipSha256: hash(compressed) }, files: siteInventory(join(out, "site")) }));
}
