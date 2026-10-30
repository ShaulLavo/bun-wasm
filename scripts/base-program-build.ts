import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Preserve package-relative WASM URLs when Bun moves family manifests into shared chunks. */
export function baseProgramAssets(consumerEntry: string): Bun.BunPlugin {
  return {
    name: "base-program-assets",
    setup(build) {
      const families = new Map<string, string>();
      build.onResolve({ filter: /^waffle-(coreutils|findutils|grep|ripgrep|sed)$/ }, ({ path, importer }) => {
        const scope = importer ? dirname(importer) : dirname(consumerEntry);
        const entry = Bun.resolveSync(path, scope);
        families.set(entry, path);
        return { path: entry };
      });
      build.onLoad({ filter: /\/src\/index\.ts$/ }, async ({ path }) => {
        const family = families.get(path);
        if (!family) return;
        const source = await Bun.file(path).text();
        if (!source.includes("import.meta.url")) throw new Error(`Program family has no asset URLs: ${family}`);
        const anchor = `new URL(${JSON.stringify(`./programs/base/${family}/src/${basename(path)}`)}, globalThis.location.href).href`;
        return { contents: source.replaceAll("import.meta.url", anchor), loader: "ts" };
      });
      build.onEnd(async result => {
        if (!result.success || !build.config.outdir) return;
        for (const [entry, family] of families)
          await copyFamily(entry, family, build.config.outdir);
      });
    },
  };
}

async function copyFamily(entry: string, family: string, output: string) {
  const directory = join(dirname(entry), "../dist");
  const assets = (await readdir(directory)).filter(name => /\.wasm(?:\.(?:br|gz))?$/.test(name));
  if (!assets.length) throw new Error(`Program family has no packed WASM: ${family}`);
  for (const name of assets)
    await Bun.write(join(output, "programs/base", family, "dist", name), Bun.file(join(directory, name)));
}
