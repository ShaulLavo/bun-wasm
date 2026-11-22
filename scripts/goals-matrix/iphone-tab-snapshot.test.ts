import { expect, test } from "bun:test";
import { batchSnapshot, ownedTabClose, privateSnapshot, proveTabClosed, proveTabsUnchanged } from "./iphone-tab-snapshot";
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

test("ordinary closure is proved when Safari exposes more cards from the same group", () => {
  const before = read(["Goals owned", "One", "Two", "Three", "Four"], 25);
  const after = ["One", "Two", "Three", "Four", "Five", "Six"];
  expect(() => proveTabClosed(before, read(after, 24), "Goals owned")).not.toThrow();
  expect(() => proveTabClosed(before, read(after, 25), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, read(after.concat("Goals owned"), 24), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, read(after, 23), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, read(after.slice(1), 24), "Goals owned")).toThrow("unproved");
  const duplicate = read(["Goals owned", "One", "One", "Two"], 25);
  expect(() => proveTabClosed(duplicate, read(after, 24), "Goals owned")).toThrow("unproved");
});

test("cleanup rejects partial batches, foreign apps and truncated native snapshots", () => {
  expect(() => batchSnapshot(batch(overview(["Goals owned"])), ["snapshot"])).toThrow("Incomplete");
  expect(() => batchSnapshot(batch({ ...overview(["Goals owned"]), truncated: true }), ["press", "snapshot"])).toThrow("snapshot");
  expect(() => batchSnapshot(batch({ ...overview(["Goals owned"]), appBundleId: "other" }), ["press", "snapshot"])).toThrow("Safari");
  expect(() => batchSnapshot(batch({ nodes: [] }), ["press", "snapshot"])).toThrow("snapshot");
});

function privateRead(labels: string[]) {
  const snapshot = overview(labels, 23);
  snapshot.nodes.find(node => node.identifier === "CapsuleTabGroup")!.label = "Private, Tab Group";
  return privateSnapshot(snapshot.nodes);
}

test("Private ownership proof carries no count and preserves every other card", () => {
  const before = privateRead(["Goals owned", "Unrelated private"]);
  expect(before).not.toHaveProperty("count");
  expect(ownedTabClose(before, "Goals owned")).toBe("@e2");
  expect(() => proveTabClosed(before, privateRead(["Unrelated private"]), "Goals owned")).not.toThrow();
  expect(() => proveTabClosed(before, privateRead([]), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, privateRead(["Replacement"]), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(before, read(["Unrelated private"]), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(privateRead(["Unrelated private"]), privateRead(["Unrelated private"]), "Goals owned")).toThrow("unproved");
  expect(() => proveTabClosed(privateRead(["Goals owned", "Goals owned"]), privateRead([]), "Goals owned")).toThrow("unproved");
  expect(() => privateSnapshot(overview(["Goals owned"]).nodes)).toThrow("selection is unproved");
});

test("Private cleanup cannot hide changes to ordinary count or contents", () => {
  const before = read(["Unrelated ordinary"], 23);
  expect(() => proveTabsUnchanged(before, read(["Unrelated ordinary"], 23))).not.toThrow();
  expect(() => proveTabsUnchanged(before, read(["Unrelated ordinary"], 22))).toThrow("changed");
  expect(() => proveTabsUnchanged(before, read(["Replacement"], 23))).toThrow("changed");
});
