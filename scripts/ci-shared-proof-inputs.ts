import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { siteInventory, verifySite } from "./browser-guest-site";
import { parseProgramInputs, parseProgramReceipt, verifyProgramReceipt } from "./guest-core-receipt";
import { stageSharedPrograms } from "./stage-program-profiles";
import { programProfile, type PairedEngine } from "../src/engine-kind";

const engines = ["quickjs", "jsc", "spidermonkey"] as const;
const repository = resolve(import.meta.dir, "..");

function source() {
  const [head, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" }).trim().split("\n");
  return { head, tree };
}

export function verifySharedProofInputs(out: string): void {
  const manifest: unknown = JSON.parse(readFileSync(join(out, "handoff.json"), "utf8"));
  const files = siteInventory(out);
  delete files["handoff.json"];
  assert.deepEqual(manifest, { source: source(), profile: "shared-group", engines, files });
  verifySite(join(out, "browser"));
}

function verifyProgramSource(directory: string, engine: PairedEngine, expected: { head: string; tree: string }): void {
  assert.equal(readFileSync(join(directory, "source.txt"), "utf8").trim(), expected.head);
  const value: unknown = JSON.parse(readFileSync(join(directory, "current-inputs.json"), "utf8"));
  assert(Array.isArray(value), "Missing current producer input snapshots");
  const current = value.map(parseProgramInputs);
  assert.deepEqual(current.map(inputs => inputs.scope), engine === "spidermonkey" ? ["core"] : ["core", engine]);
  const receipts = ["bun-core.wasm.core.json"].concat(engine === "spidermonkey" ? [] : [`${programProfile(engine).side}.engine.json`]);
  for (const [index, name] of receipts.entries()) {
    const receipt = parseProgramReceipt(JSON.parse(readFileSync(join(directory, name), "utf8")));
    const inputs = current[index]!;
    assert.deepEqual(inputs.source, expected);
    const bytes = readFileSync(join(directory, index === 0 ? "bun.wasm" : programProfile(engine).side));
    verifyProgramReceipt(index === 0 ? bytes.subarray(0, receipt.artifact.artifactBytes) : bytes, receipt, inputs);
  }
}

export async function prepareSharedProofInputs(out: string, programs: string, browser: string): Promise<void> {
  assert(!existsSync(out), "Shared handoff must not overlay existing inputs");
  const identity = verifySite(browser);
  const inputs = Object.fromEntries(engines.map(engine => {
    const directory = join(out, `program-${engine}`);
    cpSync(join(programs, engine === "quickjs" ? "program" : `program-${engine}`), directory, { recursive: true });
    verifyProgramSource(directory, engine, identity.source);
    return [engine, directory];
  }));
  cpSync(browser, join(out, "browser"), { recursive: true });
  const site = join(out, "browser/site");
  const builds: Record<string, string> = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8"));
  await stageSharedPrograms(site, builds, inputs);
  const html = readFileSync(join(site, "index.html"), "utf8");
  writeFileSync(join(site, "index.html"), html.replace(/globalThis\.__bunwasmBuilds\s*=\s*\{[^;]*?\}/, `globalThis.__bunwasmBuilds=${JSON.stringify(builds)}`));
  writeFileSync(join(site, "engine-builds.json"), JSON.stringify(builds));
  writeFileSync(join(out, "browser/site.json"), JSON.stringify({ ...identity, files: siteInventory(site) }));
  writeFileSync(join(out, "handoff.json"), JSON.stringify({ source: source(), profile: "shared-group", engines, files: siteInventory(out) }));
  verifySharedProofInputs(out);
}

if (import.meta.main) {
  const [command, out, programs, browser] = process.argv.slice(2);
  if (!out) throw new Error("Missing shared proof input directory");
  if (command === "prepare" && programs && browser) await prepareSharedProofInputs(out, programs, browser);
  else if (command === "verify") verifySharedProofInputs(out);
  else throw new Error("Usage: ci-shared-proof-inputs.ts prepare OUT PROGRAMS SITE | verify OUT");
}
