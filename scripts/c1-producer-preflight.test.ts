import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRequiredPath,
  C1_FD3,
  C1_REQUIRED_SOURCE_PATHS,
  C1_SOURCE,
  C1_TUPLE,
  type C1PreflightConfig,
  type FileIdentity,
  validateReceipt,
  validateSourceIdentity,
  validateTools,
} from "./c1-producer-preflight.ts";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureReceipt(root: string): C1PreflightConfig {
  const artifactPath = join(root, "preview1-relay.fd3.wasm");
  const receiptPath = join(root, "RECEIPT.json");
  const artifactBytes = Buffer.from("fd3 fixture\n");
  writeFileSync(artifactPath, artifactBytes);
  const receiptValue = {
    owner: C1_FD3.owner,
    kind: C1_FD3.kind,
    artifact: { path: artifactPath, bytes: artifactBytes.byteLength, sha256: digest(artifactBytes) },
    fd3Contract: { fd: C1_FD3.fd },
  };
  const receiptBytes = Buffer.from(JSON.stringify(receiptValue));
  writeFileSync(receiptPath, receiptBytes);
  const identity = (path: string, bytes: Uint8Array): FileIdentity => ({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
  return {
    sourceRoot: root,
    source: C1_SOURCE,
    receipt: { ...identity(receiptPath, receiptBytes), owner: C1_FD3.owner, kind: C1_FD3.kind, fd: C1_FD3.fd,
      artifactPath, artifactBytes: artifactBytes.byteLength, artifactSha256: digest(artifactBytes) },
    runtime: identity(join(root, "runtime.tgz"), Buffer.from("runtime")),
    relay: identity(join(root, "relay.tgz"), Buffer.from("relay")),
    programs: { ...identity(join(root, "programs.json"), Buffer.from("programs")), manifestSchema: C1_TUPLE.programManifestSchema, version: C1_TUPLE.programs },
    interfaceVersion: C1_TUPLE.hostInterface,
    tools: [],
    helpers: [],
  };
}

test("the maintained inventory rejects a fresh root missing vendor/boringssl before preparation", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-c1-preflight-missing-vendor-"));
  try {
    expect(() => assertRequiredPath(root, { path: "vendor/boringssl/CMakeLists.txt", kind: "file" })).toThrow("missing required file vendor/boringssl/CMakeLists.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exact C1 source union and reviewed fix identity are fixed inputs", () => {
  expect(validateSourceIdentity(C1_SOURCE)).toEqual(C1_SOURCE);
  expect(() => validateSourceIdentity({ head: C1_SOURCE.baseHead, tree: C1_SOURCE.baseTree })).toThrow("source is");
});

test("receipt bytes are nonzero and the hash is derived from those exact bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-c1-preflight-receipt-"));
  try {
    const config = fixtureReceipt(root);
    const result = validateReceipt(config);
    expect(result.receipt.bytes).toBeGreaterThan(0);
    expect(result.receipt.sha256).toBe(digest(requireBytes(result.receipt.path)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt hash mismatches fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-c1-preflight-receipt-hash-"));
  try {
    const config = fixtureReceipt(root);
    const receipt = config.receipt;
    if (!receipt) throw new Error("fixture receipt missing");
    expect(() => validateReceipt({ ...config, receipt: { ...receipt, sha256: "0".repeat(64) } })).toThrow("Network receipt identity mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing required helper fails closed before a producer can start", () => {
  expect(() => validateTools("helper", [])).toThrow("helper inventory is missing");
});

test("the engine producer invokes C1 preflight before it can create the producer lock", () => {
  const source = readFileSync(new URL("./engine-producer.ts", import.meta.url), "utf8");
  expect(source.indexOf("validateC1Preflight(parseC1PreflightConfig")).toBeGreaterThanOrEqual(0);
  expect(source.indexOf("validateC1Preflight(parseC1PreflightConfig")).toBeLessThan(source.indexOf("const lock = join(output, \".producer-lock\")"));
});

test("the complete required vendor inventory has explicit entries", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-c1-preflight-complete-"));
  try {
    for (const entry of C1_REQUIRED_SOURCE_PATHS) {
      const path = join(root, entry.path);
      if (entry.kind === "directory" || entry.kind === "git") mkdirSync(path, { recursive: true });
      if (entry.kind === "file") { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "fixture"); }
    }
    chmodSync(join(root, "vendor/bun/.git"), 0o600);
    expect(() => C1_REQUIRED_SOURCE_PATHS.forEach(entry => assertRequiredPath(root, entry))).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function requireBytes(path: string): Uint8Array {
  return readFileSync(path);
}
