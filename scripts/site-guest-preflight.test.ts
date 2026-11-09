import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { hash, type GuestBuild } from "./guest-source-manifest";
import { verifyGuestBuildReceipt } from "./guest-build-receipt";
import { verifySiteGuests } from "./site-guest-preflight";

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
