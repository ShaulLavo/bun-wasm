import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Target = string | null | number | boolean | Target[] | { [condition: string]: Target };
type Loader = typeof import("./loader.ts");

const root = join(process.cwd(), "package-resolution-cases");
const loaderSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "loader.ts"), "utf8");
let checks = 0;

function write(path: string, contents: string) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function moduleFile(path: string, marker: string) {
  write(path, `export const marker = ${JSON.stringify(marker)};\n`);
}

async function scope(path: string, manifest: object = {}): Promise<Loader> {
  write(`${path}/package.json`, JSON.stringify({ type: "module", ...manifest }));
  write(`${path}/loader.ts`, loaderSource);
  return import(pathToFileURL(join(root, path, "loader.ts")).href);
}

async function resolves(loader: Loader, specifier: string, marker: string) {
  assert.equal((await loader.loadImport(specifier)).marker, marker, `import ${specifier}`);
  assert.equal(loader.loadRequire(specifier).marker, marker, `require ${specifier}`);
  checks += 2;
}

async function rejects(loader: Loader, specifier: string) {
  await assert.rejects(() => loader.loadImport(specifier), `import ${specifier}`);
  assert.throws(() => loader.loadRequire(specifier), `require ${specifier}`);
  checks += 2;
}

async function patternCases(reverse: boolean) {
  const directory = reverse ? "patterns-reverse" : "patterns";
  const entries: [string, Target][] = [
    ["./feature/*", "./general/*.mjs"],
    ["./feature/*.js", "./specific/*.mjs"],
    ["./feature/deep/*", "./prefix/*.mjs"],
    ["./feature/exact.js", "./exact.mjs"],
    ["./feature/missing.js", "./missing.mjs"],
    ["./feature/*.json", null],
  ];
  if (reverse) entries.reverse();
  const exports = Object.fromEntries(entries);
  const imports = Object.fromEntries(entries.map(([key, target]) => [key.replace("./feature/", "#feature/"), target]));
  write(`${directory}/node_modules/p/package.json`, JSON.stringify({ exports }));
  for (const prefix of [directory, `${directory}/node_modules/p`]) {
    moduleFile(`${prefix}/general/item.js.mjs`, "wrong general target");
    moduleFile(`${prefix}/specific/item.mjs`, "suffix");
    moduleFile(`${prefix}/prefix/item.js.mjs`, "prefix");
    moduleFile(`${prefix}/specific/deep/item.mjs`, "wrong suffix target");
    moduleFile(`${prefix}/specific/exact.mjs`, "wrong pattern target");
    moduleFile(`${prefix}/specific/missing.mjs`, "wrong pattern fallback");
    moduleFile(`${prefix}/general/item.json.mjs`, "wrong null fallback");
    moduleFile(`${prefix}/exact.mjs`, "exact");
  }
  const loader = await scope(directory, { imports });
  for (const specifier of ["p/feature/", "#feature/"]) {
    await resolves(loader, `${specifier}item.js`, "suffix");
    await resolves(loader, `${specifier}deep/item.js`, "prefix");
    await resolves(loader, `${specifier}exact.js`, "exact");
    await rejects(loader, `${specifier}missing.js`);
    await rejects(loader, `${specifier}item.json`);
  }
}

async function targetCase(target: Target, index: number, expected: "fallback" | "reject") {
  const directory = `target-${index}`;
  write(`${directory}/node_modules/p/package.json`, JSON.stringify({ exports: target }));
  moduleFile(`${directory}/fallback.mjs`, "fallback");
  moduleFile(`${directory}/node_modules/p/fallback.mjs`, "fallback");
  const loader = await scope(directory, { imports: { "#target": target } });
  for (const specifier of ["p", "#target"]) {
    if (expected === "reject") await rejects(loader, specifier);
    else await resolves(loader, specifier, "fallback");
  }
}

async function targetCases() {
  const blocked: Target[] = [
    { bun: null, node: null, default: "./fallback.mjs" },
    { node: { node: null, default: "./fallback.mjs" }, default: "./fallback.mjs" },
    { node: 42, default: "./fallback.mjs" },
    { node: [], default: "./fallback.mjs" },
    { node: [42, null], default: "./fallback.mjs" },
    ["./missing.mjs", "./fallback.mjs"],
  ];
  const fallbacks: Target[] = [
    { browser: null, default: "./fallback.mjs" },
    { node: { browser: null }, default: "./fallback.mjs" },
    { default: "./fallback.mjs", node: null },
    [{ browser: null }, "./fallback.mjs"],
    { node: [{ browser: null }], default: "./fallback.mjs" },
  ];
  for (const [index, target] of blocked.entries()) await targetCase(target, index, "reject");
  for (const [index, target] of fallbacks.entries()) await targetCase(target, blocked.length + index, "fallback");
}

async function packageBoundaryCase(manifest: object, index: number) {
  const directory = `boundary-${index}`;
  write(`${directory}/node_modules/p/package.json`, JSON.stringify({ exports: { ".": "./index.mjs", "./extra": "./extra.mjs" } }));
  moduleFile(`${directory}/node_modules/p/index.mjs`, "ancestor root");
  moduleFile(`${directory}/node_modules/p/extra.mjs`, "ancestor subpath");
  write(`${directory}/app/node_modules/p/package.json`, JSON.stringify(manifest));
  const loader = await scope(`${directory}/app`);
  await rejects(loader, "p");
  await rejects(loader, "p/extra");
}

async function packageBoundaryCases() {
  const manifests = [
    { exports: { ".": "./missing.mjs" } },
    { exports: { ".": "./missing.mjs", "./extra": "./missing.mjs" } },
    { exports: { ".": null, "./extra": null } },
  ];
  for (const [index, manifest] of manifests.entries()) await packageBoundaryCase(manifest, index);
  await lookupCase(false);
  await lookupCase(true);
}

async function lookupCase(nearest: boolean) {
  const directory = nearest ? "lookup-nearest" : "lookup-absent";
  const manifest = { exports: { ".": "./index.mjs", "./extra": "./extra.mjs" } };
  write(`${directory}/node_modules/@scope/p/package.json`, JSON.stringify(manifest));
  moduleFile(`${directory}/node_modules/@scope/p/index.mjs`, "ancestor");
  moduleFile(`${directory}/node_modules/@scope/p/extra.mjs`, "ancestor");
  if (nearest) {
    write(`${directory}/app/node_modules/@scope/p/package.json`, JSON.stringify(manifest));
    moduleFile(`${directory}/app/node_modules/@scope/p/index.mjs`, "nearest");
    moduleFile(`${directory}/app/node_modules/@scope/p/extra.mjs`, "nearest");
  }
  const loader = await scope(`${directory}/app`);
  await resolves(loader, "@scope/p", nearest ? "nearest" : "ancestor");
  await resolves(loader, "@scope/p/extra", nearest ? "nearest" : "ancestor");
}

async function legacyNullCase() {
  write("null-field/app/node_modules/p/package.json", JSON.stringify({ exports: null, main: "./own.mjs" }));
  moduleFile("null-field/app/node_modules/p/own.mjs", "legacy null root");
  moduleFile("null-field/app/node_modules/p/extra.mjs", "legacy null subpath");
  const loader = await scope("null-field/app", { name: "p", exports: null });
  await resolves(loader, "p", "legacy null root");
  await resolves(loader, "p/extra.mjs", "legacy null subpath");
}

async function selfReferenceCases() {
  moduleFile("self/app/own.mjs", "self");
  write("self/app/node_modules/self-pkg/package.json", JSON.stringify({ exports: { ".": "./index.mjs", "./extra": "./extra.mjs" } }));
  moduleFile("self/app/node_modules/self-pkg/index.mjs", "wrong shadow root");
  moduleFile("self/app/node_modules/self-pkg/extra.mjs", "wrong shadow subpath");
  const loader = await scope("self/app", { name: "self-pkg", exports: { ".": "./own.mjs" } });
  await resolves(loader, "self-pkg", "self");
  await rejects(loader, "self-pkg/extra");
}

try {
  await patternCases(false);
  await patternCases(true);
  await targetCases();
  await packageBoundaryCases();
  await selfReferenceCases();
  await legacyNullCase();
  console.log(`package resolution: ${checks} import/require checks`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
