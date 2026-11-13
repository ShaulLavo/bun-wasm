import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializationPair } from "../tests/package/engine-initialization-fixture";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { programProfile, type PairedEngine } from "../src/engine-kind";
import { siteInventory } from "./browser-guest-site";
import { prepareSharedProofInputs, verifySharedProofInputs } from "./ci-shared-proof-inputs";
import { needsRust, needsSharedNative } from "./ci-changes";
import { hash } from "./guest-source-manifest";
import type { ProgramBuildReceipt } from "./guest-core-receipt";

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
    writeFileSync(join(directory, `${programProfile(engine).side}.engine.json`), JSON.stringify(receipt(pair.side, engine)));
    return;
  }
  const library = { profile: "shared-group", library: { sha256: "a".repeat(64), bytes: 123 }, headers: { count: 1, sha256: "b".repeat(64) } };
  const text = JSON.stringify(library);
  writeFileSync(join(directory, "shared-group-library.json"), text);
  writeFileSync(join(directory, "spidermonkey-shared.json"), JSON.stringify({ schema: 1, experimental: true, profile: "shared-group", program: identity(pair.core), side: identity(pair.side),
    inputs: { source, core: identity(pair.untaggedCore), coreReceipt: core, native: { receipt: identity(text), library: library.library, headers: library.headers } } }));
}

function seedSite(root: string): void {
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
  const sourceManifest = { ...original.sourceManifest, source };
  const guest = { ...original, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) };
  writeFileSync(join(root, "site.json"), JSON.stringify({ source, receipt: guest, guest: { sha256: hash(wasm), bytes: wasm.byteLength, gzipSha256: hash(gzip) }, files: siteInventory(site) }));
}

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
      ["bun-core.wasm.core.json", JSON.stringify({ ...core, inputs: { ...core.inputs, source: { ...source, tree: "f".repeat(40) } } })],
      ["quickjs.wasm.engine.json", JSON.stringify({ ...side, inputs: { ...side.inputs, source: { ...source, head: "f".repeat(40) } } })],
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

test.each(["scripts/ci-shared-proof-inputs.ts", "scripts/ci-shared-proof-inputs.test.ts", "checks/quality-ci-shared-proof-inputs.json"])("handoff input %s selects its existing engine producers", path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});
