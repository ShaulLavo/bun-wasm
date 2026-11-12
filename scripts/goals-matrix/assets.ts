import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
async function files(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Staged host contains a symlink: ${relative}`);
    if (entry.isDirectory()) paths.push(...await files(root, relative));
    else if (entry.isFile()) paths.push(relative);
  }
  return paths;
}
export async function assetIdentity(root: string): Promise<{ file: string; bytes: number; sha256: string }[]> {
  const paths = await files(root);
  paths.sort();
  const assets: { file: string; bytes: number; sha256: string }[] = [];
  for (const file of paths) {
    const bytes = await readFile(join(root, file));
    assets.push({ file, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  return assets;
}
