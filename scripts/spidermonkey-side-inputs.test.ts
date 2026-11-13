import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { sideSourceSha256 } from "./spidermonkey-side-inputs";

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-side-inputs-"));
  roots.add(root);
  return root;
}
function put(root: string, path: string, content = "source\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const inputs = [
  "crates/bunwasm-engine-spidermonkey/src/vm.rs", "crates/bunwasm-spidermonkey/cpp/engine.cpp",
  "crates/bunwasm-engine-quickjs/src/side_modules.rs", "crates/bunwasm-engine-quickjs/src/runtime_js_measurement.rs",
  "crates/bunwasm-runtime/src/data/codec.rs", "crates/bunwasm-runtime/src/ops/abi.rs",
  "crates/bunwasm-runtime/src/ops/client.rs", "crates/bunwasm-runtime/src/engine.rs",
  "crates/bunwasm-runtime/src/split_api.rs", "crates/other/Cargo.toml", "Cargo.toml", "Cargo.lock",
  "rust-toolchain.toml", ".cargo/config.toml", "src/engine-kind.ts", "env.sh",
  "scripts/build-engine-spidermonkey.sh", "scripts/build-bun-spidermonkey.sh", "scripts/src/engine-init.c",
  "scripts/spidermonkey-side-core-receipt.ts", "scripts/spidermonkey-side-inputs.ts",
  "crates/bunwasm-engine-quickjs/build/transfer_fault.rs",
  "scripts/guest-core-receipt.ts",
  "spidermonkey/build.sh", "spidermonkey/spidermonkey-wasi.patch", "spidermonkey/mozconfig.in",
  "spidermonkey/irregexp-icu/generated/special-case.cc",
];
for (const path of inputs) {
  test(`side freshness includes additions, changes and deletions of ${path}`, () => {
    const root = fixture();
    const absent = sideSourceSha256(root);
    put(root, path);
    const before = sideSourceSha256(root);
    expect(before).not.toBe(absent);
    put(root, path, "changed\n");
    expect(sideSourceSha256(root)).not.toBe(before);
    rmSync(join(root, path));
    expect(sideSourceSha256(root)).toBe(absent);
  });
}

test("source digest is independent of path root, creation order, Git and unrelated docs/site files", () => {
  const first = fixture();
  const second = fixture();
  for (const path of inputs) put(first, path);
  for (const path of inputs.toReversed()) put(second, path);
  expect(sideSourceSha256(first)).toBe(sideSourceSha256(second));
  for (const path of ["README.md", "docs/concepts/architecture.md", "site/build.ts", "web/build.ts", ".git/HEAD"]) put(first, path);
  expect(sideSourceSha256(first)).toBe(sideSourceSha256(second));
  renameSync(join(second, "crates/bunwasm-runtime/src/ops/client.rs"), join(second, "crates/bunwasm-runtime/src/ops/moved.rs"));
  expect(sideSourceSha256(first)).not.toBe(sideSourceSha256(second));
});
