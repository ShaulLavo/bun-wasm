import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export async function assetIdentity(root: string): Promise<unknown> {
  const names = (await readdir(root)).filter(name => /\.wasm(?:\.gz)?$/.test(name));
  const programNames = await readdir(join(root, "programs")).catch(() => []);
  const paths = names.concat(programNames.filter(name => name.endsWith(".wasm")).map(name => `programs/${name}`));
  paths.sort();
  const assets: { file: string; bytes: number; sha256: string }[] = [];
  for (const file of paths) {
    const bytes = await readFile(join(root, file));
    assets.push({ file, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  return assets;
}
