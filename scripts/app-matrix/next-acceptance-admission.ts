import assert from "node:assert/strict";
import { dirname } from "node:path";
import { verifyRegistryInventory, readRegistryIndex } from "../../web/tests/next-framework-registry";
import { registryReceipt } from "./next-acceptance-registry";

export function assertPreviewPageOrigin(pageUrl: string, previewUrl: string): void {
  const intended = new URL(previewUrl);
  const actual = new URL(pageUrl);
  assert.ok(intended.protocol === "http:" || intended.protocol === "https:", "Preview must have an HTTP origin");
  assert.ok(actual.protocol === "http:" || actual.protocol === "https:", "Preview request page must be admitted before probes");
  assert.equal(actual.origin, intended.origin, "Preview request page has the wrong origin");
}

// Identity comes from the selected original index bytes, not the materialized cache.
export function verifyReplayAdmission(paths: readonly string[], originalIdentity: string | undefined) {
  assert.match(originalIdentity ?? "", /^[a-f0-9]{64}$/, "Replay requires --registry-identity from the selected ORIGINAL indexes");
  const receipt = registryReceipt(paths);
  assert.equal(receipt.sha256, originalIdentity, "Selected original replay index identity mismatch");
  const inventory = receipt.inputs.map(input => {
    const directory = dirname(input.path);
    const entries = readRegistryIndex(directory, input.sha256);
    return { ...input, ...verifyRegistryInventory(directory, entries, input.path) };
  });
  assert.equal(registryReceipt(paths).sha256, originalIdentity, "Replay indexes changed during admission");
  return { ...receipt, inventory };
}
