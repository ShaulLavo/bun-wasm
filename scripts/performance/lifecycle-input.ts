import { readFileSync } from "node:fs";
import { join } from "node:path";
import { array, canonical, object, sha256, string, treeInventory } from "./input";

export function verifyInstalledPacket(root: string, inventoryPath: string): string {
  const expected = array(object(JSON.parse(readFileSync(inventoryPath, "utf8"))).files).map(value => {
    const entry = object(value);
    return { path: string(entry.path), kind: "link" in entry ? "symlink" : "file", sha256: "link" in entry ? sha256(string(entry.link)) : string(entry.sha256) };
  });
  const actual = treeInventory(join(root, "node_modules"));
  expected.sort((a, b) => a.path.localeCompare(b.path));
  actual.sort((a, b) => a.path.localeCompare(b.path));
  if (canonical(actual) !== canonical(expected)) throw new Error(`Prepared installed packet differs from inventory: ${inventoryPath}`);
  return sha256(canonical(actual));
}
export function verifyExactFixture(root: string, workload: "next" | "vite"): void {
  const source = workload === "next" ? "sandbox/template-next" : "sandbox/template";
  for (const file of treeInventory(source).filter(entry => entry.path !== "bun.lock")) {
    if (file.kind !== "file" || sha256(readFileSync(join(root, file.path))) !== file.sha256) throw new Error(`Fixture differs from checked-in source: ${file.path}`);
  }
}
