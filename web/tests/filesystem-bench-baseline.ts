import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Keep imports made by the named baseline inside that archive. In particular, main's
 * web/src/fs.ts reexports its own runtime package; resolving that through the head
 * consumer would silently benchmark the changed MemoryBackend in both direct arms. */
export function filesystemBaselinePlugin(root: string): Bun.BunPlugin {
  const baseline = resolve(root);
  const packageDirectory = existsSync(join(baseline, "waffle/package.json")) ? "waffle" : "runtime";
  const packageRoot = join(baseline, packageDirectory);
  const packageName = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name as string;
  const packagePrefix = new RegExp(`^${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:/|$)`);
  return { name: "named-baseline", setup(build) {
    build.onResolve({ filter: /^benchmark:baseline-/ }, ({ path }) => ({ path: resolve(baseline, path.endsWith("core") ? `${packageDirectory}/core/index.ts` : "web/src/fs.ts") }));
    build.onResolve({ filter: packagePrefix }, ({ path, importer }) => {
      if (importer.startsWith(baseline + sep)) return { path: Bun.resolveSync(path, packageRoot) };
    });
  } };
}
