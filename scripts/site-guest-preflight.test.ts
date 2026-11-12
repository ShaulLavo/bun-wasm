import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { hash, type GuestBuild } from "./guest-source-manifest";
import { artifactIdentity, verifyGuestBuildReceipt } from "./guest-build-receipt";
import { resolveSiteSpiderMonkey, verifySiteGuests } from "./site-guest-preflight";
import { parseInputs, verifyPairReceipt, writePairReceipt } from "./spidermonkey-side-core-receipt";
import { sideSourceSha256 } from "./spidermonkey-side-inputs";
import { appendCustomSection } from "../src/engine-kind";

const cleanup = new Set<string>();
afterEach(async () => {
  for (const path of cleanup) await rm(path, { recursive: true, force: true });
  cleanup.clear();
});
const runtime = "crates/bunwasm-runtime/src/js/worker_threads.ts";
const embedded = [runtime, "crates/bunwasm-runtime/src/js/worker_codec.ts", "crates/bunwasm-runtime/build/polyfills.rs",
  "scripts/transpile-runtime.ts", "scripts/generate-bun-wrap.ts", "scripts/generate-direct-stream.ts", "web/src/native-direct-stream.ts"];
const builds: readonly GuestBuild[] = ["browser", "quickjs", "jsc", "tools"];

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-site-guests-"));
  cleanup.add(root);
  for (const path of embedded) await put(root, path, `current ${path}\n`);
  const files = await Promise.all(embedded.map(async path => {
    const bytes = await readFile(join(root, path));
    return { path, sha256: hash(bytes), bytes: bytes.length };
  }));
  for (const build of builds) {
    const pair = build === "quickjs" || build === "jsc" ? quickjsPair(build) : null;
    const core = pair?.core ?? wasm;
    const receipt = fixtureReceipt(core, build, pair?.side);
    const sourceManifest = { ...receipt.sourceManifest, groups: receipt.sourceManifest.groups.map(group => group.name === "repository" ? { ...group, files } : group) };
    const current = { ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) };
    const name = build === "quickjs" ? "bun.wasm" : `bun-${build}.wasm`;
    await put(root, `dist/${name}`, core);
    await put(root, `dist/${name}.build.json`, JSON.stringify(current));
    if (pair) await put(root, `dist/${build === "jsc" ? "jsc-engine" : "quickjs"}.wasm`, pair.side);
  }
  return root;
}

test("site publication rejects a stale embedded worker runtime despite valid artifact receipts", async () => {
  const root = await fixture();
  await put(root, runtime, "new shared lane contract\n");
  await expect(verifySiteGuests(root, {})).rejects.toThrow(runtime);
});

test("matching embedded inputs allow unrelated host commits and type-only changes", async () => {
  const root = await fixture();
  await put(root, "README.md", "unrelated documentation\n");
  await put(root, "crates/bunwasm-runtime/src/js/runtime.d.ts", "type Only = true;\n");
  await expect(verifySiteGuests(root, {})).resolves.toBeUndefined();
});

for (const path of ["crates/bunwasm-runtime/src/js/added.ts", "scripts/transpile-runtime.ts", "web/src/native-direct-stream.ts"]) {
  test(`publication rejects changed or added embedded input ${path}`, async () => {
    const root = await fixture();
    await put(root, path, "changed embedded code\n");
    await expect(verifySiteGuests(root, {})).rejects.toThrow(path);
  });
}

test("publication rejects an embedded module removed after the guest was built", async () => {
  const root = await fixture();
  await rm(join(root, runtime));
  await expect(verifySiteGuests(root, {})).rejects.toThrow(runtime);
});

test("publication checks each guest and requires its receipt", async () => {
  const root = await fixture();
  const path = join(root, "dist/bun-tools.wasm.build.json");
  await rm(path);
  await expect(verifySiteGuests(root, {})).rejects.toThrow(path);
});

test("publication validates companion bytes instead of trusting the recorded pair", async () => {
  const root = await fixture();
  await put(root, "dist/quickjs.wasm", quickjsPair("jsc").side);
  await expect(verifySiteGuests(root, {})).rejects.toThrow();
});

test("artifact overrides use the same app-relative paths as sandbox and playground builds", async () => {
  const root = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-site-override-"));
  cleanup.add(directory);
  await put(directory, "browser.wasm", wasm);
  await put(directory, "browser.wasm.build.json", await readFile(join(root, "dist/bun-browser.wasm.build.json")));
  await expect(verifySiteGuests(root, { BUN_BROWSER_WASM: join(directory, "browser.wasm") })).resolves.toBeUndefined();
  await put(root, "alternate/browser.wasm", wasm);
  await put(root, "alternate/browser.wasm.build.json", await readFile(join(root, "dist/bun-browser.wasm.build.json")));
  await expect(verifySiteGuests(root, { BUN_BROWSER_WASM: "../alternate/browser.wasm" })).resolves.toBeUndefined();
});

test("publication checks playground assets when a relative override selects different files", async () => {
  const root = await fixture();
  await put(root, "sandbox/browser.wasm", wasm);
  await put(root, "sandbox/browser.wasm.build.json", await readFile(join(root, "dist/bun-browser.wasm.build.json")));
  await put(root, "web/browser.wasm", wasm);
  await expect(verifySiteGuests(root, { BUN_BROWSER_WASM: "browser.wasm" })).rejects.toThrow(join(root, "web/browser.wasm.build.json"));
});

test("publication rejects a guest override for the wrong engine", async () => {
  const root = await fixture();
  await expect(verifySiteGuests(root, { BUN_BROWSER_WASM: "../dist/bun.wasm" })).rejects.toThrow("engine mismatch");
});

test("site build rejects stale guests before installing or building shell and app payloads", async () => {
  const root = await fixture();
  const result = Bun.spawnSync([process.execPath, new URL("../site/build.ts", import.meta.url).pathname], {
    env: { ...process.env, BUN_BROWSER_WASM: join(root, "dist/bun-browser.wasm") },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Site guest has stale embedded runtime inputs");
  expect(result.stdout.toString()).not.toContain("bun install");
});


test("publication rejects the CI source-cache browser producer even with matching runtime inputs", async () => {
  const root = await fixture();
  const path = join(root, "dist/bun-browser.wasm.build.json");
  const receipt: unknown = JSON.parse(await readFile(path, "utf8"));
  verifyGuestBuildReceipt(wasm, receipt);
  const sourceManifest = { ...receipt.sourceManifest, build: "source-cache-browser" } as const;
  await writeFile(path, JSON.stringify({ ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) }));
  await expect(verifySiteGuests(root, {})).rejects.toThrow("engine mismatch");
});

async function spiderMonkeyFixture(root: string, directory = "dist", core = quickjsPair("spidermonkey").core) {
  const path = join(root, directory, "bun-spidermonkey.wasm");
  const side = join(root, directory, "spidermonkey-engine.wasm");
  const inputs = parseInputs({ schema: 1, scope: "spidermonkey-side-core", profile: "split",
    source: { head: "a".repeat(40), tree: "b".repeat(40) }, sideSourceSha256: sideSourceSha256(root),
    native: { receiptSha256: hash("synthetic receipt"), archiveSha256: hash("synthetic archive"), archiveBytes: 1, profileSha256: hash("split") } });
  await put(root, `${directory}/bun-spidermonkey.wasm`, core);
  await put(root, `${directory}/spidermonkey-engine.wasm`, quickjsPair("spidermonkey").side);
  await put(root, `${directory}/inputs.json`, JSON.stringify(inputs));
  writePairReceipt(path, side, inputs);
  return { path, side, receipt: `${path}.spidermonkey.json`, inputsPath: join(root, directory, "inputs.json"), inputs };
}

test("optional site selection allows absent SpiderMonkey and resolves default and explicit pairs absolutely", async () => {
  const root = await fixture();
  expect(resolveSiteSpiderMonkey(root, {})).toBeNull();
  await expect(verifySiteGuests(root, {})).resolves.toBeUndefined();
  const pair = await spiderMonkeyFixture(root);
  expect(resolveSiteSpiderMonkey(root, {})).toBe(pair.path);
  await expect(verifySiteGuests(root, {})).resolves.toBeUndefined();
  const selected = await spiderMonkeyFixture(root, "custom");
  await rm(pair.side);
  const env = { SPIDERMONKEY_WASM: "../custom/bun-spidermonkey.wasm" };
  expect(resolveSiteSpiderMonkey(root, env)).toBe(selected.path);
  await expect(verifySiteGuests(root, env)).resolves.toBeUndefined();
  await expect(verifySiteGuests(root, { SPIDERMONKEY_WASM: selected.path })).resolves.toBeUndefined();
});

test("empty and missing explicit selections fail even when the optional default is absent", async () => {
  const root = await fixture();
  await expect(verifySiteGuests(root, { SPIDERMONKEY_WASM: "" })).rejects.toThrow("must select a core");
  await expect(verifySiteGuests(root, { SPIDERMONKEY_WASM: "../missing.wasm" })).rejects.toThrow();
});

for (const missing of ["path", "side", "receipt", "inputsPath"] as const) {
  test(`selected SpiderMonkey requires its ${missing}`, async () => {
    const root = await fixture();
    const pair = await spiderMonkeyFixture(root);
    await rm(pair[missing]);
    await expect(verifySiteGuests(root, { SPIDERMONKEY_WASM: pair.path })).rejects.toThrow();
  });
}

for (const target of ["path", "side"] as const) {
  test(`selected SpiderMonkey rejects changed ${target} bytes`, async () => {
    const root = await fixture();
    const pair = await spiderMonkeyFixture(root);
    await writeFile(pair[target], appendCustomSection(await readFile(pair[target]), "changed", new Uint8Array()));
    await expect(verifySiteGuests(root, {})).rejects.toThrow();
  });
}

for (const target of ["receipt", "inputsPath"] as const) {
  const fields = target === "receipt" ? ["profile", "sideSourceSha256", "core.bytes", "side.bytes", "native.archiveSha256"]
    : ["profile", "sideSourceSha256", "native.archiveSha256"];
  for (const field of fields) {
    test(`selected SpiderMonkey rejects changed ${target} ${field}`, async () => {
      const root = await fixture();
      const pair = await spiderMonkeyFixture(root);
      const value = JSON.parse(await readFile(pair[target], "utf8"));
      if (field === "profile") value.profile = "shared-group";
      if (field === "sideSourceSha256") delete value.sideSourceSha256;
      if (field === "native.archiveSha256") value.native.archiveSha256 = hash("different native");
      if (field === "core.bytes") value.core.bytes++;
      if (field === "side.bytes") value.side.bytes++;
      await writeFile(pair[target], JSON.stringify(value));
      await expect(verifySiteGuests(root, {})).rejects.toThrow();
    });
  }
}

test("pair metadata preserves the digest through parser, writer and verifier", async () => {
  const root = await fixture();
  const pair = await spiderMonkeyFixture(root);
  expect(parseInputs(JSON.parse(await readFile(pair.inputsPath, "utf8"))).sideSourceSha256).toBe(sideSourceSha256(root));
  const receipt = verifyPairReceipt(pair.path, pair.side, pair.receipt, pair.inputs);
  expect(receipt.sideSourceSha256).toBe(pair.inputs.sideSourceSha256);
  expect(() => verifyPairReceipt(pair.path, pair.side, pair.receipt, { ...pair.inputs, sideSourceSha256: hash("stale") }))
    .toThrow("side source identity mismatch");
});

test("selected SpiderMonkey rejects unresolved side imports even with matching artifact hashes", async () => {
  const root = await fixture();
  const pair = await spiderMonkeyFixture(root);
  const side = await readFile(pair.side);
  const offset = side.indexOf("core_checkpoint");
  expect(offset).toBeGreaterThan(0);
  side.set(new TextEncoder().encode("evil_checkpoint"), offset);
  expect(WebAssembly.validate(side)).toBe(true);
  await writeFile(pair.side, side);
  const receipt = JSON.parse(await readFile(pair.receipt, "utf8"));
  receipt.side = { sha256: hash(side), bytes: side.byteLength };
  await writeFile(pair.receipt, JSON.stringify(receipt));
  await expect(verifySiteGuests(root, {})).rejects.toThrow("unresolved core imports");
});

test("side freshness rejects a changed nested runtime source but allows unrelated site and docs changes", async () => {
  const root = await fixture();
  const nested = "crates/bunwasm-runtime/src/ops/client.rs";
  await put(root, nested, "current side ABI\n");
  await spiderMonkeyFixture(root);
  await put(root, "README.md", "unrelated\n");
  await put(root, "site/build.ts", "unrelated\n");
  await expect(verifySiteGuests(root, {})).resolves.toBeUndefined();
  await put(root, nested, "changed side ABI\n");
  await expect(verifySiteGuests(root, {})).rejects.toThrow("stale side source");
});

test("selected SpiderMonkey still requires current embedded runtime in the qualified core", async () => {
  const root = await fixture();
  await spiderMonkeyFixture(root);
  await put(root, runtime, "changed embedded runtime\n");
  await expect(verifySiteGuests(root, {})).rejects.toThrow("stale embedded runtime");
});

test("valid SpiderMonkey pair with different remaining custom section bytes fails core comparison", async () => {
  const root = await fixture();
  await spiderMonkeyFixture(root, "dist", appendCustomSection(quickjsPair("spidermonkey").core, "producer", Uint8Array.of(1)));
  await expect(verifySiteGuests(root, {})).rejects.toThrow("differs from the qualified QuickJS core");
});

test("core comparison retains matching non-engine custom sections and uses the selected playground QuickJS core", async () => {
  const root = await fixture();
  const core = appendCustomSection(quickjsPair().core, "producer", Uint8Array.of(1));
  const receipt: unknown = JSON.parse(await readFile(join(root, "dist/bun.wasm.build.json"), "utf8"));
  verifyGuestBuildReceipt(quickjsPair().core, receipt);
  const updated = { ...receipt, program: { ...receipt.program, core: artifactIdentity(core) } };
  await put(root, "alternate/bun.wasm", core);
  await put(root, "alternate/bun.wasm.build.json", JSON.stringify(updated));
  await put(root, "alternate/quickjs.wasm", quickjsPair().side);
  await spiderMonkeyFixture(root, "dist", appendCustomSection(quickjsPair("spidermonkey").core, "producer", Uint8Array.of(1)));
  await expect(verifySiteGuests(root, { BUN_WASM: "../alternate/bun.wasm" })).resolves.toBeUndefined();
  await expect(verifySiteGuests(root, {})).rejects.toThrow("differs from the qualified QuickJS core");
});

for (const tag of ["jsc", "duplicate", "missing"] as const) {
  test(`selected SpiderMonkey rejects a ${tag} engine tag despite matching recorded bytes`, async () => {
    const root = await fixture();
    const pair = await spiderMonkeyFixture(root);
    let core = quickjsPair("jsc").core;
    if (tag === "duplicate") core = appendCustomSection(quickjsPair("spidermonkey").core, "bun-wasm-engine", new TextEncoder().encode("spidermonkey"));
    if (tag === "missing") core = quickjsPair("spidermonkey").core.slice(0, -(3 + "bun-wasm-engine".length + "spidermonkey".length));
    expect(WebAssembly.validate(core)).toBe(true);
    await writeFile(pair.path, core);
    const receipt = JSON.parse(await readFile(pair.receipt, "utf8"));
    receipt.core = { sha256: hash(core), bytes: core.byteLength };
    await writeFile(pair.receipt, JSON.stringify(receipt));
    await expect(verifySiteGuests(root, {})).rejects.toThrow();
  });
}

test("site build resolves the pair and propagates its absolute path before expensive app steps", async () => {
  const source = await readFile(new URL("../site/build.ts", import.meta.url), "utf8");
  const resolution = source.indexOf("const spiderMonkey = resolveSiteSpiderMonkey(root)");
  const preflight = source.indexOf("await verifySiteGuests(root, process.env, spiderMonkey)");
  const propagation = source.indexOf("process.env.SPIDERMONKEY_WASM = spiderMonkey");
  const shell = source.indexOf('const guests = Bun.spawn');
  expect(resolution).toBeGreaterThan(0);
  expect(preflight).toBeGreaterThan(resolution);
  expect(propagation).toBeGreaterThan(preflight);
  expect(shell).toBeGreaterThan(propagation);
  expect(source.indexOf('await build("web")')).toBeGreaterThan(propagation);
});
