/** Test-only tree inventory, in parent-before-child order. File payloads stay binary. */
export type FixtureEntry = { readonly kind: "directory" | "file"; readonly path: string };

function relativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\\\0]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function parseFixtureTree(value: unknown): FixtureEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid fixture tree inventory");
  const seen = new Set<string>();
  const directories = new Set([""]);
  return value.map((item: unknown): FixtureEntry => {
    if (!item || typeof item !== "object" || !("path" in item) || !relativePath(item.path) || !("kind" in item)) throw new Error("Invalid fixture tree entry");
    const path = item.path;
    if (seen.has(path) || !directories.has(path.split("/").slice(0, -1).join("/"))) throw new Error(`Duplicate or missing fixture parent: ${path}`);
    seen.add(path);
    if (item.kind !== "file" && item.kind !== "directory") throw new Error(`Invalid fixture kind: ${path}`);
    if (item.kind === "directory") directories.add(path);
    return { kind: item.kind, path };
  });
}

interface FixtureFilesystem {
  mkdirp(path: string): Promise<unknown>;
  writeFile(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<unknown>;
}

export async function installFixtureTree(filesystem: FixtureFilesystem, root: string, entries: readonly FixtureEntry[], load: (path: string) => Promise<Uint8Array<ArrayBuffer>>): Promise<void> {
  await filesystem.mkdirp(root);
  for (const entry of entries) {
    const path = `${root === "/" ? "" : root}/${entry.path}`;
    if (entry.kind === "directory") await filesystem.mkdirp(path);
    else await filesystem.writeFile(path, await load(entry.path));
  }
}

export function fixtureFileUrl(path: string): string {
  return `./fixture/${path.split("/").map(encodeURIComponent).join("/")}`;
}
