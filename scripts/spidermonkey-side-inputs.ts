import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directories = [
  "crates/bunwasm-engine-spidermonkey", "crates/bunwasm-spidermonkey",
  "crates/bunwasm-engine-quickjs/src", "crates/bunwasm-runtime/src",
  ".cargo", "spidermonkey",
];
const recipes = [
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain", "env.sh",
  "crates/bunwasm-engine-quickjs/build.rs", "crates/bunwasm-runtime/build.rs",
  "scripts/build-engine-spidermonkey.sh", "scripts/build-bun-spidermonkey.sh",
  "scripts/spidermonkey-side-core-receipt.ts", "scripts/spidermonkey-side-inputs.ts",
  "scripts/guest-build-receipt.ts", "scripts/guest-source-manifest.ts",
  "scripts/src/engine-init.c", "src/engine-kind.ts",
];
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function collect(repository: string, path: string): string[] {
  const absolute = join(repository, path);
  if (!existsSync(absolute)) return [];
  const metadata = lstatSync(absolute);
  if (metadata.isFile()) return path.endsWith(".md") ? [] : [path];
  if (!metadata.isDirectory()) throw new Error(`Unsupported SpiderMonkey source input: ${path}`);
  return readdirSync(absolute).sort().flatMap(name => collect(repository, `${path}/${name}`));
}

/** Content identity of the ordinary side and its native recipes, independent of Git provenance. */
export function sideSourceSha256(repository: string): string {
  const crates = join(repository, "crates");
  const manifests = existsSync(crates) ? readdirSync(crates).map(name => `crates/${name}/Cargo.toml`) : [];
  const paths = Array.from(new Set(directories.concat(recipes, manifests).flatMap(path => collect(repository, path)))).sort();
  return hash(JSON.stringify(paths.map(path => [path, hash(readFileSync(join(repository, path)))])));
}
