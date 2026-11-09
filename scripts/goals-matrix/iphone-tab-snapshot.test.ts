import { expect, test } from "bun:test";
import { batchSnapshot, ownedTabClose, proveTabClosed } from "./iphone-tab-snapshot";
import { tabOverview as overview, tabBatch as batch } from "./iphone-tab-fixture";

function read(labels: string[], count?: number) {
  return batchSnapshot(batch(overview(labels, count)), ["press", "snapshot"]);
}

test("cleanup identifies Close by its owning tab, then proves that tab alone disappeared", () => {
  const before = read(["Unrelated", "Goals owned"]);
  expect(ownedTabClose(before, "Goals owned")).toBe("@e4");
  expect(() => proveTabClosed(before, read(["Unrelated"]), "Goals owned")).not.toThrow();
  expect(() => ownedTabClose(before, "Absent")).toThrow("identify");
  expect(() => ownedTabClose(read(["Goals owned", "Goals owned"]), "Goals owned")).toThrow("identify");
});

test("cleanup refuses missing ownership, wrong tab removal and merely hidden tabs", () => {
  const snapshot = overview(["Unrelated", "Goals owned"]);
  snapshot.nodes[3]!.parentIndex = 0;
  const parsed = batchSnapshot(batch(snapshot), ["press", "snapshot"]);
  expect(() => ownedTabClose(parsed, "Goals owned")).toThrow("Close button");
  const before = read(["Unrelated", "Goals owned"]);
  expect(() => proveTabClosed(before, read(["Goals owned"]), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, read(["Unrelated"], 2), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, read(["Replacement"]), "Goals owned")).toThrow("unproved");
});

test("cleanup rejects partial batches, foreign apps and truncated native snapshots", () => {
  expect(() => batchSnapshot(batch(overview(["Goals owned"])), ["snapshot"])).toThrow("Incomplete");
  expect(() => batchSnapshot(batch({ ...overview(["Goals owned"]), truncated: true }), ["press", "snapshot"])).toThrow("snapshot");
  expect(() => batchSnapshot(batch({ ...overview(["Goals owned"]), appBundleId: "other" }), ["press", "snapshot"])).toThrow("Safari");
  expect(() => batchSnapshot(batch({ nodes: [] }), ["press", "snapshot"])).toThrow("snapshot");
});
