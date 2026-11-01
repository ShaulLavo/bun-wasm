import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { parseCheck } from "./test-checks";

export function checkInputPaths(check: ReturnType<typeof parseCheck>): string[] {
  if (check.owner === "native-probe") return [check.path].concat(check.inputs);
  if (check.owner === "native") return [`${check.path}/`];
  return check.owner === "runtime" ? [check.path] : [];
}

export function matchesCheckInput(path: string, inputs: readonly string[]): boolean {
  return inputs.some(input => input.endsWith("/") ? path.startsWith(input) : path === input);
}

function treeEntry(entry: string) {
  const separator = entry.indexOf("\t");
  const [mode, kind, object] = entry.slice(0, separator).split(" ");
  if (separator < 0 || !mode || !kind || !object) throw new Error("Invalid Git tree entry");
  return { mode, kind, object, path: entry.slice(separator + 1) };
}

export function nativeCheckInputsAt(ref: string): string[] {
  if (/^0{40}$/.test(ref)) return [];
  const tree = execFileSync("git", ["ls-tree", "-r", "-t", "-z", "--full-tree", ref, "--", "checks"], { encoding: "utf8" });
  const [directory, ...manifests] = tree.split("\0").filter(Boolean).map(treeEntry);
  if (!directory) return [];
  if (directory.path !== "checks" || directory.mode !== "040000" || directory.kind !== "tree") throw new Error(`Unsafe check directory at ${ref}`);
  if (manifests.length === 0) throw new Error(`Missing check manifests at ${ref}`);
  for (const manifest of manifests) {
    const regular = manifest.kind === "blob" && (manifest.mode === "100644" || manifest.mode === "100755");
    if (!regular || !/^checks\/[a-z0-9-]+\.json$/.test(manifest.path)) throw new Error(`Unsafe check manifest at ${ref}: ${manifest.path}`);
  }
  const blobs = execFileSync("git", ["cat-file", "--batch"], { input: manifests.map(manifest => manifest.object).join("\n") + "\n" });
  let offset = 0;
  return manifests.flatMap(manifest => {
    const end = blobs.indexOf(10, offset);
    if (end < 0) throw new Error(`Missing check blob at ${ref}: ${manifest.path}`);
    const [object, kind, size] = blobs.toString("utf8", offset, end).split(" ");
    const length = Number(size);
    const start = end + 1;
    if (object !== manifest.object || kind !== "blob" || !Number.isSafeInteger(length) || length < 0 || blobs[start + length] !== 10) throw new Error(`Invalid check blob at ${ref}: ${manifest.path}`);
    const check = parseCheck(JSON.parse(blobs.toString("utf8", start, start + length)), basename(manifest.path));
    offset = start + length + 1;
    const inputs = checkInputPaths(check);
    return inputs.length ? inputs.concat([manifest.path]) : [];
  });
}
