import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const identity = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
const adapter = "spidermonkey/irregexp-icu";
function codePoints(value: unknown): number[] {
  assert(Array.isArray(value));
  return value.map((point: unknown) => {
    assert(typeof point === "number" && Number.isInteger(point) && point >= 0 && point <= 0xffff);
    return point;
  });
}
function body(name: string, points: readonly number[]) {
  const lines = [`icu::UnicodeSet Build${name}() {`, "  icu::UnicodeSet set;"];
  for (let i = 0; i < points.length;) {
    const first = points[i++]; assert(first !== undefined);
    let last = first;
    while (points[i] === last + 1) { last++; i++; }
    lines.push(first === last ? `  set.add(0x${first.toString(16)});` : `  set.add(0x${first.toString(16)}, 0x${last.toString(16)});`);
  }
  return lines.concat(["  set.freeze();", "  return set;", "}"]).join("\n");
}
function lockCrates() {
  const names = new Set(["icu_casemap", "icu_casemap_data", "icu_properties", "icu_properties_data", "icu_collections", "icu_locale_core"]);
  return readFileSync("Cargo.lock", "utf8").split("[[package]]").flatMap((block) => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    if (!name || !names.has(name)) return [];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    const checksum = block.match(/^checksum = "([^"]+)"$/m)?.[1];
    assert(version === "2.4.0" && checksum);
    return [{ name, version, checksum }];
  });
}
function resolvedCrates() {
  const raw: unknown = JSON.parse(execFileSync("cargo", ["metadata", "--offline", "--locked", "--format-version", "1"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  assert(raw && typeof raw === "object" && "packages" in raw && Array.isArray(raw.packages));
  const packages = raw.packages;
  const locks = lockCrates();
  return locks.map((lock) => {
    const item: unknown = packages.find((pkg: unknown) => pkg && typeof pkg === "object" && "name" in pkg && pkg.name === lock.name);
    assert(item && typeof item === "object" && "manifest_path" in item && typeof item.manifest_path === "string");
    const root = dirname(item.manifest_path);
    const entries = readdirSync(root, { recursive: true, encoding: "utf8" }).sort().filter((path) => /\.(?:rs|data)$/.test(path));
    const files = entries.map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) }));
    return { ...lock, sourceFileCount: files.length, sourceManifestSha256: hash(JSON.stringify(files)) };
  });
}
function main() {
  const check = process.argv.includes("--check");
  const template = join(adapter, "templates/special-case.cc");
  const upstreamGenerator = join(adapter, "templates/gen-regexp-special-case.cc");
  assert.equal(identity(template).sha256, "32eb6ebcbc9e9d32f9aa936ae59b39b14121efbc94da01abf68fd789ffdff1cd");
  assert.equal(identity(upstreamGenerator).sha256, "e5709c3cb71e949becd81f57193cf7b558b823da2eabaea00388f22316f5ce17");
  const raw: unknown = JSON.parse(execFileSync("cargo", ["run", "--offline", "--locked", "-j", "4", "-p", "bunwasm-spidermonkey", "--features", "unicode-generator", "--example", "unicode-special-case"], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
  assert(raw && typeof raw === "object" && "ignore" in raw && "supplementary" in raw);
  const ignore = codePoints(raw.ignore);
  const supplementary = codePoints(raw.supplementary);
  let generated = readFileSync(template, "utf8");
  for (const [name, points] of [["IgnoreSet", ignore], ["SupplementaryEquivalentsSet", supplementary]] satisfies [string, number[]][]) {
    const pattern = new RegExp(`icu::UnicodeSet Build${name}\\(\\) \\{[\\s\\S]*?\\n\\}`);
    assert(pattern.test(generated));
    generated = generated.replace(pattern, body(name, points));
  }
  const output = join(adapter, "generated/special-case.cc");
  const receipt = {
    profile: { intlApi: false, irregexpUnicode: "icu4x-subset", specialCase: "selected-data-generated" },
    unicodeVersion: "18.0.0", mozillaRevision: "a5df22d986d4b626f771b4f8885241941601c35c",
    generator: [identity("spidermonkey/generate-special-case.ts"), identity("crates/bunwasm-spidermonkey/examples/unicode-special-case.rs"), identity("crates/bunwasm-spidermonkey/src/glue/special_case.rs")],
    upstream: [identity(upstreamGenerator), identity(template), identity(join(adapter, "templates/irregexp/imported/special-case.h"))],
    lock: identity("Cargo.lock"), crates: resolvedCrates(),
    output: { path: output, sha256: hash(generated) }, ignoreCount: ignore.length, supplementary,
  };
  const receiptBytes = JSON.stringify(receipt, null, 2) + "\n";
  const receiptPath = join(adapter, "generated/special-case.inputs.json");
  if (check) {
    assert.equal(readFileSync(output, "utf8"), generated, "generated source is stale");
    assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes, "generator/data custody is stale");
  } else {
    writeFileSync(output, generated);
    writeFileSync(receiptPath, receiptBytes);
  }
  process.stdout.write(JSON.stringify({ ignoreCount: ignore.length, supplementary, outputSha256: hash(generated), check }) + "\n");
}
main();
