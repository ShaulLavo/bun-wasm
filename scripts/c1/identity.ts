import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileIdentity, TreeIdentity } from "./contract.ts";

class IdentityError extends Error {}
const chunk = Buffer.allocUnsafe(1024 * 1024);

export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Bytes and SHA-256 of a regular file, streamed. A symlink is never followed. */
export function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!isAbsolute(path) || !stat?.isFile()) throw new IdentityError(`expected an absolute regular file: ${path}`);
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (let count = readSync(fd, chunk); count > 0; count = readSync(fd, chunk)) {
      hash.update(chunk.subarray(0, count));
      bytes += count;
    }
  } finally { closeSync(fd); }
  return { path, bytes, sha256: hash.digest("hex") };
}

export function sameBytes(a: Pick<FileIdentity, "bytes" | "sha256">, b: Pick<FileIdentity, "bytes" | "sha256">): boolean {
  return a.bytes === b.bytes && a.sha256 === b.sha256;
}
/** The file at `expected.path` still has exactly the stated bytes. */
export function requireFile(expected: FileIdentity, label: string): FileIdentity {
  const actual = fileIdentity(expected.path);
  if (!sameBytes(actual, expected)) throw new IdentityError(`${label} changed: ${expected.path} has ${actual.bytes} bytes ${actual.sha256}, expected ${expected.bytes} ${expected.sha256}`);
  return actual;
}

export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
}
/** Physical form of a path whose tail may not exist yet: the nearest existing ancestor is resolved. */
export function physicalPath(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function treeLines(root: string, path: string): string[] {
  if (path.split("/").includes(".git")) return [];
  const full = join(root, path);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) return [linkLine(root, path, full)];
  if (stat.isDirectory()) return [`directory\0${path}\n`].concat(readdirSync(full).sort().flatMap(name => treeLines(root, path ? `${path}/${name}` : name)));
  if (!stat.isFile()) throw new IdentityError(`unsupported tree entry: ${full}`);
  const file = fileIdentity(full);
  return [`file\0${path}\0${stat.mode & 0o777}\0${file.bytes}\0${file.sha256}\n`];
}
function linkLine(root: string, path: string, full: string): string {
  const target = readlinkSync(full);
  const resolved = resolve(dirname(full), target);
  if (!inside(root, resolved) || !inside(realpathSync(root), physicalPath(resolved))) throw new IdentityError(`tree link escapes its root: ${full} -> ${target}`);
  // Absolute internal links are recorded relative, so a private copy has the same identity.
  return `link\0${path}\0${isAbsolute(target) ? relative(dirname(full), resolved) : target}\n`;
}
/**
 * Identity of a whole directory: every entry, mode, link target and file
 * hash, in sorted order. Git metadata is excluded. `selection` limits the walk
 * to named top-level entries.
 */
function treeWalk(path: string, selection?: readonly string[]): string[] {
  if (!isAbsolute(path) || !lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new IdentityError(`expected an absolute directory: ${path}`);
  return selection ? selection.flatMap(entry => treeLines(path, entry)) : readdirSync(path).sort().flatMap(name => treeLines(path, name));
}
function identityOf(path: string, lines: readonly string[]): TreeIdentity {
  const files = lines.filter(line => line.startsWith("file\0") || line.startsWith("link\0")).length;
  const bytes = lines.reduce((total, line) => total + (line.startsWith("file\0") ? Number(line.split("\0")[3]) : 0), 0);
  return { path, files, bytes, sha256: sha256(lines.join("")) };
}
export function treeIdentity(path: string, selection?: readonly string[]): TreeIdentity {
  return identityOf(path, treeWalk(path, selection));
}
export function requireTree(expected: TreeIdentity, label: string, selection?: readonly string[]): TreeIdentity {
  const actual = treeIdentity(expected.path, selection);
  if (!sameBytes(actual, expected) || actual.files !== expected.files) throw new IdentityError(`${label} tree changed: ${expected.path}`);
  return actual;
}
/**
 * The regular files of an admitted tree, by relative path, read in the same
 * walk that proves the tree still has its admitted identity. Links are not
 * files: a path through a link is never a member.
 */
export function requireTreeInventory(expected: TreeIdentity, label: string): ReadonlyMap<string, { readonly bytes: number; readonly sha256: string }> {
  const lines = treeWalk(expected.path);
  const actual = identityOf(expected.path, lines);
  if (!sameBytes(actual, expected) || actual.files !== expected.files) throw new IdentityError(`${label} tree changed since admission: ${expected.path}`);
  return new Map(lines.filter(line => line.startsWith("file\0")).map(line => {
    const [, path = "", , bytes = "0", digest = ""] = line.trimEnd().split("\0");
    return [path, { bytes: Number(bytes), sha256: digest }];
  }));
}
