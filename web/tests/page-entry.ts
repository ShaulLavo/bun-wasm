import type { Runtime } from "waffle";
import { fileTimeMs } from "waffle/core/filesystem";
import type { Node } from "waffle/fs/memory";

type Entry = NonNullable<Awaited<ReturnType<Runtime["filesystem"]["lookup"]>>>;

const stat = (node: Node) => ({ ino: node.ino, mtime: fileTimeMs(node.mtime), ctime: fileTimeMs(node.ctime) });
const leaf = (node: Exclude<Node, { kind: "dir" }>) =>
  node.kind === "symlink" ? { ...stat(node), kind: node.kind, target: node.target } : { ...stat(node), kind: node.kind };
const child = (node: Node) => node.kind === "dir" ? { ...stat(node), kind: node.kind } : leaf(node);

/** A memory node as the page's filesystem answers `lookup` (Waffle's fs/backend.ts lookup). */
export function pageEntry(node: Node | undefined): Entry | undefined {
  if (!node) return undefined;
  if (node.kind !== "dir") return leaf(node);
  return { ...stat(node), kind: "dir", children: new Map(Array.from(node.children, ([name, item]) => [name, child(item)])) };
}
