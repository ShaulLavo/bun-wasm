import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { migrationBase, migrationOutputs, rewriteLinks, splitLedger } from "./split-bun-patches";

const root = new URL("../../", import.meta.url).pathname;

test("the pinned ledger splits deterministically without dropping any section or classified row", () => {
  const output = migrationOutputs(root);
  expect(output.sectionCount).toBe(143);
  expect(output.rowCount).toBe(168);
  expect(output.anchors.size).toBe(145);
  expect(output.files.get("scripts/migrations/bun-patches-map.json")).toBe(readFileSync(new URL("./bun-patches-map.json", import.meta.url), "utf8"));
  expect(migrationBase).toMatch(/^[a-f0-9]{40}$/);
});

test("split records preserve prose, revision context, classification and local links", () => {
  const source = '# Ledger\n\nPinned `abc123`.\n\n| Patch or source | Class | Change |\n| --- | --- | --- |\n| [Sink](#bun-array-buffer-sink) | Port | Original row. |\n\n## Parent\n\nShared revision.\n\n### Bun ArrayBufferSink\n\nExact prose. [Peer](#peer). [Guide](guide.md#api).\n\n## Peer\n\nOther prose.\n';
  const output = splitLedger(source);
  const sink = output.files.get("docs/bun-patches/bun-arraybuffersink.md")!;
  expect(sink).toContain("Exact prose. [Peer](peer.md#peer). [Guide](../guide.md#api).");
  expect(sink).toContain("| [Sink](#bun-array-buffer-sink) | Port | Original row. |");
  expect(sink).toContain("[Parent context](parent.md).");
  expect(output.files.get("docs/bun-patches/scope.md")).toContain("Pinned `abc123`.");
});

test("duplicate sections and unknown anchors fail instead of silently losing content", () => {
  expect(() => splitLedger("# Empty\n")).toThrow("No ledger sections");
  expect(() => splitLedger("| Patch or source |\n## Same\n## Same\n")).toThrow("Duplicate anchor");
  expect(() => rewriteLinks("[Bad](bun-patches.md#absent)", "docs/guide.md", "docs/guide.md", new Map())).toThrow("Unresolved ledger link");
});
