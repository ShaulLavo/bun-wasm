import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureProgramInputs } from "./guest-core-receipt.ts";
import { captureSourceManifest, hash } from "./guest-source-manifest.ts";
import { fixtureGit, withReceiptFixture } from "../tests/package/guest-receipt-fixture.ts";

const paths = [
  "crates/bunwasm-crypto-sys/src/tls.rs",
  "crates/bunwasm-glue/Cargo.toml",
  "crates/bunwasm-glue/src/lib.rs",
  "crates/bunwasm-glue/src/extra.rs",
  "crates/bunwasm-runtime/src/lib.rs",
  "crates/bunwasm-runtime/src/tls.rs",
  "crates/bunwasm-runtime/src/tls/bindings.rs",
  "crates/bunwasm-runtime/src/tls/context.rs",
  "crates/bunwasm-runtime/src/tls/driver.rs",
  "crates/bunwasm-runtime/src/tls/owned.rs",
  "crates/bunwasm-runtime/src/tls/slots.rs",
  "crates/bunwasm-runtime/src/tls/tests.rs",
  "crates/bunwasm-runtime/src/tls/trust.rs",
  "crates/bunwasm-runtime/data/tls-roots.der",
  "crates/bunwasm-runtime/data/tls-roots.source.json",
];

async function stageTls(root: string) {
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  fixtureGit(root, "add", "crates");
  fixtureGit(root, "commit", "-m", "exact TLS source fixture, no compilation");
}

async function assertTlsFiles(manifest: Awaited<ReturnType<typeof captureSourceManifest>>) {
  const files = manifest.groups.find(group => group.name === "repository")?.files;
  expect(files).toBeDefined();
  for (const path of paths) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    expect(files).toContainEqual({ path, bytes: bytes.byteLength, sha256: hash(bytes) });
  }
}

test("guest and split-core collectors bind every actual TLS source, root and provenance byte", async () => {
  await withReceiptFixture(async options => {
    await stageTls(options.repository);
    for (const scope of ["guest", "core"] as const) {
      const manifest = await captureSourceManifest(options, scope);
      await assertTlsFiles(manifest);
    }
  });
});

test("trust bytes and provenance drift invalidate core inputs without changing engine inputs", async () => {
  await withReceiptFixture(async options => {
    await stageTls(options.repository);
    const core = () => captureProgramInputs(options, "core", { features: ["engine-split"] });
    const side = () => captureProgramInputs({ ...options, build: "quickjs" }, "quickjs");
    let previous = await core();
    const originalSide = await side();
    for (const path of paths.slice(-2)) {
      const file = join(options.repository, path);
      const bytes = await readFile(file);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(file, bytes);
      fixtureGit(options.repository, "add", path);
      fixtureGit(options.repository, "commit", "-m", "change only trust fixture bytes");
      const current = await core();
      expect(current.contentSha256).not.toBe(previous.contentSha256);
      expect((await side()).contentSha256).toBe(originalSide.contentSha256);
      previous = current;
    }
  });
});
