import { programProfile } from "../../src/engine-kind";
import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadNodeProgram } from "../scripts/node-linked";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function scratch() {
  const root = await mkdtemp(join(process.env.SCRATCH ?? tmpdir(), "bun-wasm-pair-consumers-"));
  roots.push(root);
  return root;
}

async function stagedAssets(root: string, project: "web" | "sandbox" = "sandbox", env: Record<string, string> = {}) {
  const source = await Bun.file(new URL(`../../${project}/build.ts`, import.meta.url)).text();
  const start = source.indexOf("const engineBuilds:");
  const end = project === "sandbox" ? source.indexOf("\nfor (const template of templates)") : source.indexOf("await buildShellAssets(");
  if (start < 0 || end <= start) throw new Error(`${project} engine staging boundary missing`);
  const engineBlock = source.slice(start, end);
  const writeManifest = source.split("\n").find(line => line.startsWith('await Bun.write(join(out, "engine-builds.json")'));
  if (!writeManifest) throw new Error(`${project} engine manifest writer missing`);
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`${engineBlock}\n${writeManifest}`);
  const run = new Function("Bun", "existsSync", "statSync", "dirname", "join", "resolve", "here", "out", "process", "wasmSource", `return (async () => { ${body} })();`);
  const here = join(root, project), out = join(root, "output");
  await mkdir(out, { recursive: true });
  await run(Bun, existsSync, statSync, dirname, join, resolve, here, out, { env }, join(root, "dist/bun.wasm"));
  return out;
}

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
test("sandbox stages matching QuickJS side gzip and manifest with the core", async () => {
  const root = await scratch();
  const { core, side } = quickjsPair();
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/bun.wasm"), core);
  await writeFile(join(root, "dist/quickjs.wasm"), side);
  const out = await stagedAssets(root);
  expect(Bun.gunzipSync(await readFile(join(out, "bun.wasm.gz")))).toEqual(core);
  expect(Bun.gunzipSync(await readFile(join(out, "quickjs.wasm.gz")))).toEqual(side);
  expect(JSON.parse(await readFile(join(out, "engine-builds.json"), "utf8"))).toEqual({ "bun.wasm": digest(core), "quickjs.wasm": digest(side) });
  await rm(join(root, "dist/quickjs.wasm"));
  await expect(stagedAssets(root)).rejects.toThrow("matching side module");
});

for (const kind of ["quickjs", "jsc"] as const) test(`${kind} Node retains distinct pair associations through selected child lookup`, async () => {
  const root = await scratch();
  const { core, side } = quickjsPair(kind);
  const profile = programProfile(kind);
  const sideB = Uint8Array.from(Array.from(side).concat([0, 2, 1, 120]));
  for (const [name, bytes] of [["a", side], ["b", sideB]] as const) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, profile.core), core);
    await writeFile(join(root, name, profile.side), bytes);
  }
  const first = await loadNodeProgram(join(root, "a", profile.core));
  const second = await loadNodeProgram(join(root, "b", profile.core));
  expect(first.module).not.toBe(second.module);
  expect((await loadNodeProgram(join(root, "a", profile.core))).module).toBe(first.module);
  const programs = new Map([[first.module, first.linkPlan], [second.module, second.linkPlan]]);
  expect(programs.get(first.module)?.libraries[0]?.source).toEqual(side);
  expect(programs.get(second.module)?.libraries[0]?.source).toEqual(sideB);
  const { createNodeExecutableRegistry } = await import("../scripts/node-spawn");
  await mkdir(join(root, `opt/bun/${kind}/bin`), { recursive: true });
  await writeFile(join(root, `opt/bun/${kind}/bin/bun`), new Uint8Array());
  const registry = createNodeExecutableRegistry(first.module, { "/": root }, { [kind]: second.module });
  const child = await registry.resolve(`/opt/bun/${kind}/bin/bun`);
  if (child.kind !== "module") throw new Error("Selected paired engine must resolve to a Wasm module");
  expect(child.module).toBe(second.module);
  expect(programs.get(child.module)?.libraries[0]?.source).toEqual(sideB);
  const ordinaryBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  await writeFile(join(root, "ordinary.wasm"), ordinaryBytes);
  const ordinary = await loadNodeProgram(join(root, "ordinary.wasm"));
  expect(ordinary.linkPlan).toBeUndefined();
  expect(programs.has(ordinary.module)).toBe(false);
});

for (const project of ["web", "sandbox"] as const) test(`${project} stages the JSC pair from its overridden directory`, async () => {
  const root = await scratch();
  const { core, side } = quickjsPair("jsc");
  const selected = join(root, "selected");
  await mkdir(selected);
  await writeFile(join(selected, "bun-jsc.wasm"), core);
  await writeFile(join(selected, "jsc-engine.wasm"), side);
  const env = { JSC_WASM: join(selected, "bun-jsc.wasm") };
  const out = await stagedAssets(root, project, env);
  expect(Bun.gunzipSync(await readFile(join(out, "bun-jsc.wasm.gz")))).toEqual(core);
  expect(Bun.gunzipSync(await readFile(join(out, "jsc-engine.wasm.gz")))).toEqual(side);
  expect(JSON.parse(await readFile(join(out, "engine-builds.json"), "utf8"))).toEqual({ "bun-jsc.wasm": digest(core), "jsc-engine.wasm": digest(side) });
  await rm(join(selected, "jsc-engine.wasm"));
  await expect(stagedAssets(root, project, env)).rejects.toThrow("matching side module");
});

for (const project of ["web", "sandbox"] as const) test(`${project} engine staging permits missing optional guests`, async () => {
  const root = await scratch();
  const out = await stagedAssets(root, project);
  expect(JSON.parse(await readFile(join(out, "engine-builds.json"), "utf8"))).toEqual({});
  expect(await readdir(out)).toEqual(["engine-builds.json"]);
});
