import { expect, test } from "bun:test";
import { guestProvenance, verifyPlaygroundBuilds } from "./product-provenance";

const artifact = { sha256: "a".repeat(64), bytes: 123 };
const receipt = `source_commit=${"b".repeat(40)}\nsource_tree=${"c".repeat(40)}\nguest_sha256=${artifact.sha256}\nguest_bytes=123\ndate=2026-10-25T06:54:28+02:00\nfeatures=engine-host,bun-transpiler,bun-build\ntarget=wasm32-wasip1\n`;

test("guest source identity remains distinct from the harness revision", () => {
  const provenance = guestProvenance(receipt, artifact);
  expect(provenance.source_commit).toBe("b".repeat(40));
  expect(provenance.artifact_sha256).toBe(artifact.sha256);
});

test("guest receipt must describe the actual artifact bytes and full commit identities", () => {
  expect(() => guestProvenance(receipt, { ...artifact, bytes: 124 })).toThrow("does not match");
  expect(() => guestProvenance(receipt.replace("source_commit=" + "b".repeat(40), "source_commit=main"), artifact)).toThrow("Invalid guest source");
  expect(() => guestProvenance(receipt + "source_commit=" + "b".repeat(40), artifact)).toThrow("Duplicate");
});

test("a stale playground guest cannot become a current baseline", () => {
  expect(() => verifyPlaygroundBuilds({ "bun-browser.wasm": artifact.sha256 }, { "bun-browser.wasm": artifact.sha256 })).not.toThrow();
  expect(() => verifyPlaygroundBuilds({ "bun-browser.wasm": "stale" }, { "bun-browser.wasm": artifact.sha256 })).toThrow("differs");
  expect(() => verifyPlaygroundBuilds(null, { "bun-browser.wasm": artifact.sha256 })).toThrow("invalid");
});
