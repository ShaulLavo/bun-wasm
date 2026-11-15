import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { coverageBatches } from "./browser-guest-catalogue";
import { parseCheck, type NativeEngine } from "./test-checks";

type NativeInputSelection = ({ profile?: "split"; engine?: NativeEngine } | { profile: "shared-group"; engine?: never }) & {
  family?: "native-correctness" | "ordinary-browser";
};

export function checkInputPaths(check: ReturnType<typeof parseCheck>): string[] {
  if (check.owner === "native-probe") return [check.path].concat(check.inputs);
  if (check.owner === "native") return [`${check.path}/`];
  // These rows use the separate owner/engine selector, including historical inputs.
  if (check.owner === "browser-guest" && Object.values(coverageBatches).some(batch => batch === check.batch)) return [check.path];
  if (check.owner === "browser-guest") return [check.path].concat(check.inputs);
  return check.owner === "runtime" ? [check.path].concat(check.inputs) : [];
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

export function verifiedCheckManifestsAt(ref: string, cwd = process.cwd()): { file: string; value: unknown; check: ReturnType<typeof parseCheck> }[] {
  if (/^0{40}$/.test(ref)) return [];
  const tree = execFileSync("git", ["ls-tree", "-r", "-t", "-z", "--full-tree", ref, "--", "checks"], { cwd, encoding: "utf8", timeout: 5_000 });
  const [directory, ...manifests] = tree.split("\0").filter(Boolean).map(treeEntry);
  if (!directory) return [];
  if (directory.path !== "checks" || directory.mode !== "040000" || directory.kind !== "tree") throw new Error(`Unsafe check directory at ${ref}`);
  if (manifests.length === 0) throw new Error(`Missing check manifests at ${ref}`);
  for (const manifest of manifests) {
    const regular = manifest.kind === "blob" && (manifest.mode === "100644" || manifest.mode === "100755");
    if (!regular || !/^checks\/[a-z0-9-]+\.json$/.test(manifest.path)) throw new Error(`Unsafe check manifest at ${ref}: ${manifest.path}`);
  }
  const blobs = execFileSync("git", ["cat-file", "--batch"], { cwd, input: manifests.map(manifest => manifest.object).join("\n") + "\n", timeout: 5_000 });
  let offset = 0;
  return manifests.map(manifest => {
    const end = blobs.indexOf(10, offset);
    if (end < 0) throw new Error(`Missing check blob at ${ref}: ${manifest.path}`);
    const [object, kind, size] = blobs.toString("utf8", offset, end).split(" ");
    const length = Number(size);
    const start = end + 1;
    if (object !== manifest.object || kind !== "blob" || !Number.isSafeInteger(length) || length < 0 || blobs[start + length] !== 10) throw new Error(`Invalid check blob at ${ref}: ${manifest.path}`);
    const value: unknown = JSON.parse(blobs.toString("utf8", start, start + length));
    const check = parseCheck(value, basename(manifest.path));
    offset = start + length + 1;
    return { file: manifest.path, value, check };
  });
}

export function nativeCheckInputsAt(ref: string, selection: NativeInputSelection = {}, read = verifiedCheckManifestsAt): string[] {
  const { profile, engine, family } = selection;
  return read(ref).flatMap(({ file, check }) => {
    const ordinaryBrowser = check.owner === "browser-guest" && check.profile !== "shared-group";
    if (family === "native-correctness" && ordinaryBrowser) return [];
    if (family === "ordinary-browser" && !ordinaryBrowser) return [];
    if (profile !== undefined && ((check.owner !== "native" && check.owner !== "browser-guest") || (check.profile ?? "split") !== profile)) return [];
    if (engine !== undefined && (check.owner !== "native" || check.profile === "shared-group" || !(check.engines ?? ["quickjs"]).includes(engine))) return [];
    const inputs = checkInputPaths(check);
    return inputs.length ? inputs.concat([file]) : [];
  });
}
