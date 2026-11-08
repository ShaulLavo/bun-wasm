import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const stableRuntimes = ["app-page", "app-route", "pages", "pages-api", "server"].map(name => `node_modules/next/dist/compiled/next-server/${name}.runtime.prod.js`);
export const alternateRuntimes = [
  "app-page-experimental", "app-page-turbo-experimental", "app-page-turbo",
  "app-route-experimental", "app-route-turbo-experimental", "app-route-turbo",
  "pages-api-turbo", "pages-turbo",
].map(name => `node_modules/next/dist/compiled/next-server/${name}.runtime.prod.js`);

function objectFile(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected object in ${path}`);
  return Object.fromEntries(Object.entries(value));
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export function tracedFiles(project: string): Set<string> {
  const selected = new Set<string>();
  for (const manifest of files(join(project, ".next")).filter(path => path.endsWith(".nft.json"))) {
    const trace = objectFile(manifest);
    if (!Array.isArray(trace.files) || !trace.files.every(file => typeof file === "string")) throw new Error(`Invalid trace ${manifest}`);
    for (const file of trace.files) selected.add(projectRelative(project, resolve(dirname(manifest), file)));
  }
  return selected;
}

function projectRelative(project: string, path: string): string {
  const name = relative(project, path);
  if (name === ".." || name.startsWith(`..${sep}`) || name.startsWith(sep)) throw new Error(`Trace escapes project: ${path}`);
  return name;
}

export function assertRuntimeTrace(selected: ReadonlySet<string>): void {
  const required = "node_modules/next/dist/compiled/next-server/pages.runtime.prod.js";
  if (!selected.has(required)) throw new Error(`Required stable runtime missing from trace: ${required}`);
  for (const path of alternateRuntimes) if (selected.has(path)) throw new Error(`Unused alternate runtime remains traced: ${path}`);
}

export function selectedRuntime(source: string, env: Record<string, string>): string {
  const requested: string[] = [];
  const module = { exports: {} };
  new Function("module", "require", "process", source)(module, (path: string) => { requested.push(path); return {}; }, { env });
  if (requested.length !== 1 || !requested[0]) throw new Error(`Expected one runtime selection, received ${requested.join(", ")}`);
  return requested[0];
}

function assertPinnedSelection(project: string): Record<string, string> {
  for (const [name, version] of [["next", "15.5.6"], ["react", "19.1.1"], ["react-dom", "19.1.1"]]) {
    if (!name || objectFile(join(project, "node_modules", name, "package.json")).version !== version) throw new Error(`Unexpected pinned ${name} version`);
  }
  const manifest = objectFile(join(project, ".next/required-server-files.json"));
  const exports: Record<string, unknown> = {};
  new Function("exports", readFileSync(join(project, "node_modules/next/dist/lib/needs-experimental-react.js"), "utf8"))(exports);
  if (typeof exports.needsExperimentalReact !== "function" || exports.needsExperimentalReact(manifest.config)) throw new Error("The fixture must not select experimental React");
  const selection: Record<string, string> = {};
  for (const kind of ["app-page", "app-route", "pages", "pages-api"]) {
    const path = join(project, `node_modules/next/dist/server/route-modules/${kind}/module.compiled.js`);
    selection[kind] = selectedRuntime(readFileSync(path, "utf8"), { NODE_ENV: "production", NEXT_RUNTIME: "nodejs" });
    if (selection[kind] !== `next/dist/compiled/next-server/${kind}.runtime.prod.js`) throw new Error(`Unexpected ${kind} runtime ${selection[kind]}`);
  }
  return selection;
}

function copyFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}

export function stageTrace(project: string, destination: string): { selected: number; dependencies: number; dependencyBytes: number; excludedVariantBytes: number; selection: Record<string, string> } {
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) throw new Error(`Trace staging requires a fresh empty destination: ${destination}`);
  const selection = assertPinnedSelection(project);
  const selected = tracedFiles(project);
  assertRuntimeTrace(selected);
  const dependencies = Array.from(selected).filter(path => path.startsWith("node_modules/"));
  for (const path of dependencies) copyFile(join(project, path), join(destination, path));
  for (const path of files(join(project, ".next"))) copyFile(path, join(destination, projectRelative(project, path)));
  copyFile(join(project, "package.json"), join(destination, "package.json"));
  if (existsSync(join(destination, "node_modules/next/dist/bin/next"))) throw new Error("Restricted fixture unexpectedly copied the full Next package");
  const dependencyBytes = dependencies.reduce((sum, path) => sum + statSync(join(destination, path)).size, 0);
  const excludedVariantBytes = alternateRuntimes.reduce((sum, path) => sum + statSync(join(project, path)).size, 0);
  return { selected: selected.size, dependencies: dependencies.length, dependencyBytes, excludedVariantBytes, selection };
}

if (import.meta.main) {
  const [project, destination] = process.argv.slice(2);
  if (!project || !destination) throw new Error("Usage: bun next-trace-fixture.ts PROJECT DESTINATION");
  const result = stageTrace(resolve(project), resolve(destination));
  renameSync(join(project, "node_modules"), join(dirname(destination), "untraced-node-modules"));
  console.log(JSON.stringify({ ...result, originalDependenciesRemoved: true }));
}
