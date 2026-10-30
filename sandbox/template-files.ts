import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export async function templateFiles(directory: string, base = directory): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  for (const name of readdirSync(directory).sort()) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) Object.assign(files, await templateFiles(path, base));
    else files[relative(base, path)] = await Bun.file(path).text();
  }
  return files;
}

