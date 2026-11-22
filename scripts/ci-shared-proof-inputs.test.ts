import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializationPair } from "../tests/package/engine-initialization-fixture";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { programProfile, type PairedEngine } from "../src/engine-kind";
import { siteInventory } from "./browser-guest-site";
import { prepareSharedProofInputs, verifySharedProofInputs } from "./ci-shared-proof-inputs";
import { needsRust, needsSharedNative } from "./ci-changes";
import { hash } from "./guest-source-manifest";
import { parseProgramReceipt, record, type ProgramBuildReceipt } from "./guest-core-receipt";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const [head, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { encoding: "utf8" }).trim().split("\n");
const source = { head: head!, tree: tree! };
const identity = (bytes: Uint8Array | string) => ({ sha256: hash(bytes), bytes: typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength });

function receipt(bytes: Uint8Array, scope: "core" | "quickjs" | "jsc"): ProgramBuildReceipt {
  const content = { selection: { profile: "shared-group" }, fixture: "Synthetic CI transfer test, not engine qualification" };
  return { schema: 1, inputs: { schema: 1, scope, source, content, contentSha256: hash(JSON.stringify(content)) }, artifact: { artifactSha256: hash(bytes), artifactBytes: bytes.byteLength } };
}

function seedProgram(root: string, engine: PairedEngine): void {
  const directory = join(root, engine === "quickjs" ? "program" : `program-${engine}`);
  mkdirSync(directory, { recursive: true });
  const pair = initializationPair(engine, true);
  const core = receipt(pair.untaggedCore, "core");
  writeFileSync(join(directory, "bun.wasm"), pair.core);
  writeFileSync(join(directory, programProfile(engine).side), pair.side);
  writeFileSync(join(directory, "source.txt"), source.head + "\n");
  writeFileSync(join(directory, "bun-core.wasm.core.json"), JSON.stringify(core));
  if (engine !== "spidermonkey") {
    const side = receipt(pair.side, engine);
    writeFileSync(join(directory, `${programProfile(engine).side}.engine.json`), JSON.stringify(side));
    writeFileSync(join(directory, "current-inputs.json"), JSON.stringify([core.inputs, side.inputs]));
    return;
  }
  writeFileSync(join(directory, "current-inputs.json"), JSON.stringify([core.inputs]));
  const library = { profile: "shared-group", library: { sha256: "a".repeat(64), bytes: 123 }, headers: { count: 1, sha256: "b".repeat(64) } };
  const text = JSON.stringify(library);
  writeFileSync(join(directory, "shared-group-library.json"), text);
  writeFileSync(join(directory, "spidermonkey-shared.json"), JSON.stringify({ schema: 1, experimental: true, profile: "shared-group", program: identity(pair.core), side: identity(pair.side),
    inputs: { source, core: identity(pair.untaggedCore), coreReceipt: core, native: { receipt: identity(text), library: library.library, headers: library.headers } } }));
}

function seedSite(root: string, siteSource = source): void {
  const site = join(root, "site");
  mkdirSync(join(site, "sandbox"), { recursive: true });
  const gzip = Bun.gzipSync(wasm);
  for (const directory of [site, join(site, "sandbox")]) {
    writeFileSync(join(directory, "bun-browser.wasm.gz"), gzip);
    writeFileSync(join(directory, "engine-builds.json"), JSON.stringify({ "bun-browser.wasm": hash(wasm) }));
  }
  writeFileSync(join(site, "index.html"), "<script>globalThis.__bunwasmBuilds={};</script>");
  writeFileSync(join(site, "shell.wasm.gz"), "ordinary shell fixture bytes");
  const original = fixtureReceipt(wasm, "browser");
  const sourceManifest = { ...original.sourceManifest, source: siteSource };
  const guest = { ...original, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) };
  writeFileSync(join(root, "site.json"), JSON.stringify({ source: siteSource, receipt: guest, guest: { sha256: hash(wasm), bytes: wasm.byteLength, gzipSha256: hash(gzip) }, files: siteInventory(site) }));
}

function seedDownloads(root: string): string {
  const programs = join(root, "producer");
  const downloads = join(root, "shared-program-downloads");
  const spiderMonkey = join(downloads, "shared-spidermonkey-program", "bun-wasm/bun-wasm/target/shared-native");
  mkdirSync(spiderMonkey, { recursive: true });
  for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) seedProgram(programs, engine);
  renameSync(join(programs, "program"), join(downloads, "shared-quickjs-program"));
  renameSync(join(programs, "program-jsc"), join(downloads, "shared-jsc-program"));
  const destination = join(spiderMonkey, "program-spidermonkey");
  renameSync(join(programs, "program-spidermonkey"), destination);
  return destination;
}

test.each(["matching inputs", "missing program", "different site source"])("workflow assembly handles %s", defect => {
  const workflow: unknown = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  if (!record(workflow) || !record(workflow.jobs)) throw new Error("Missing workflow jobs");
  const job = workflow.jobs["ordinary-web-guests"];
  if (!record(job) || !Array.isArray(job.steps)) throw new Error("Missing ordinary Web guest job");
  const step: unknown = job.steps.find(step => record(step) && step.name === "Prepare the same-source shared proof handoff");
  if (!record(step) || typeof step.run !== "string") throw new Error("Missing shared proof assembly command");
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-downloads-"));
  try {
    const spiderMonkey = seedDownloads(root);
    if (defect === "missing program") rmSync(spiderMonkey, { recursive: true });
    seedSite(join(root, "shared-playground-site"), defect === "different site source" ? { head: "a".repeat(40), tree: "b".repeat(40) } : source);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], { env: { ...process.env, RUNNER_TEMP: root }, encoding: "utf8" });
    const out = join(root, "shared-proof-inputs");
    if (defect === "matching inputs") {
      expect(result.status, result.stderr).toBe(0);
      expect(() => verifySharedProofInputs(out)).not.toThrow();
      return;
    }
    expect(result.status).toBe(1);
    expect(existsSync(out)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ready shared handoff preserves programs, original receipts and normal shell assets without any build", async () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-handoff-"));
  try {
    const programs = join(root, "programs"), browser = join(root, "browser"), out = join(root, "out");
    for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) seedProgram(programs, engine);
    seedSite(browser);
    await prepareSharedProofInputs(out, programs, browser);
    expect(() => verifySharedProofInputs(out)).not.toThrow();
    expect(readFileSync(join(out, "browser/site/shell.wasm.gz"))).toEqual(readFileSync(join(browser, "site/shell.wasm.gz")));
    expect(readFileSync(join(out, "program-spidermonkey/spidermonkey-shared.json"))).toEqual(readFileSync(join(programs, "program-spidermonkey/spidermonkey-shared.json")));
    for (const file of ["program-quickjs/source.txt", "program-jsc/bun.wasm", "program-spidermonkey/shared-group-library.json", "browser/site/shell.wasm.gz", "browser/site/profiles/shared-group/jsc-engine.wasm.gz"]) {
      const copy = join(root, "changed");
      cpSync(out, copy, { recursive: true });
      writeFileSync(join(copy, file), "changed");
      expect(() => verifySharedProofInputs(copy)).toThrow();
      rmSync(copy, { recursive: true });
    }
    const core = receipt(initializationPair("quickjs", true).untaggedCore, "core");
    const side = receipt(initializationPair("quickjs", true).side, "quickjs");
    const defects: [string, string][] = [
      ["source.txt", "f".repeat(40)],
      ["current-inputs.json", JSON.stringify([{ ...core.inputs, source: { ...source, tree: "f".repeat(40) } }, side.inputs])],
      ["current-inputs.json", JSON.stringify([{ ...core.inputs, content: { selection: { profile: "shared-group" }, changed: true }, contentSha256: hash(JSON.stringify({ selection: { profile: "shared-group" }, changed: true })) }, side.inputs])],
      ["quickjs.wasm.engine.json", JSON.stringify({ ...side, inputs: { ...side.inputs, content: { selection: { profile: "split" } } } })],
      ["quickjs.wasm", "wrong engine bytes"],
    ];
    for (const [name, bytes] of defects) {
      const path = join(programs, "program", name), original = readFileSync(path), invalid = join(root, "invalid");
      writeFileSync(path, bytes);
      await expect(prepareSharedProofInputs(invalid, programs, browser)).rejects.toThrow();
      writeFileSync(path, original);
      rmSync(invalid, { recursive: true, force: true });
    }
    await expect(prepareSharedProofInputs(out, programs, browser)).rejects.toThrow("overlay");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function olderProgramOrigins(directory: string, engine: PairedEngine): string[] {
  const corePath = join(directory, "bun-core.wasm.core.json");
  const original = parseProgramReceipt(JSON.parse(readFileSync(corePath, "utf8")));
  const core = { ...original, inputs: { ...original.inputs, source: { head: "a".repeat(40), tree: "b".repeat(40) } } };
  writeFileSync(corePath, JSON.stringify(core));
  if (engine === "spidermonkey") {
    const path = join(directory, "spidermonkey-shared.json");
    const pair: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(pair) || !record(pair.inputs)) throw new Error("Invalid synthetic pair fixture");
    pair.inputs.coreReceipt = core;
    writeFileSync(path, JSON.stringify(pair));
    return [corePath, path];
  }
  const path = join(directory, `${programProfile(engine).side}.engine.json`);
  const side = parseProgramReceipt(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify({ ...side, inputs: { ...side.inputs, source: { head: "c".repeat(40), tree: "d".repeat(40) } } }));
  return [corePath, path];
}

test("current composition accepts compatible older core and side origins unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-shared-origins-"));
  try {
    const programs = join(root, "programs"), browser = join(root, "browser");
    for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) seedProgram(programs, engine);
    seedSite(browser);
    const files = (["quickjs", "jsc", "spidermonkey"] as const).flatMap(engine => {
      const directory = join(programs, engine === "quickjs" ? "program" : `program-${engine}`);
      return olderProgramOrigins(directory, engine);
    });
    const originals = files.map(path => readFileSync(path));
    await prepareSharedProofInputs(join(root, "out"), programs, browser);
    expect(files.map(path => readFileSync(path))).toEqual(originals);
    expect(() => verifySharedProofInputs(join(root, "out"))).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["scripts/ci-shared-proof-inputs.ts", "scripts/ci-shared-proof-inputs.test.ts", "checks/quality-ci-shared-proof-inputs.json"])("handoff input %s selects its existing engine producers", path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});
