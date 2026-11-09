import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { hash, type GuestBuild } from "./guest-source-manifest";
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
    receipt.sourceManifest.groups.find(group => group.name === "repository")!.files = files;
    receipt.sourceManifestSha256 = hash(JSON.stringify(receipt.sourceManifest));
    const name = build === "quickjs" ? "bun.wasm" : `bun-${build}.wasm`;
    await put(root, `dist/${name}`, core);
    await put(root, `dist/${name}.build.json`, JSON.stringify(receipt));
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
