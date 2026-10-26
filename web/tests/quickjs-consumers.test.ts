import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function sandboxAssets(root: string) {
  const source = await Bun.file(new URL("../../sandbox/build.ts", import.meta.url)).text();
  const engineBlock = source.slice(source.indexOf("const engineBuilds:"), source.indexOf("// ---------- the starter project"));
  const writeManifest = source.split("\n").find(line => line.startsWith('await Bun.write(join(out, "engine-builds.json")'));
  if (!writeManifest) throw new Error("sandbox manifest writer missing");
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`${engineBlock}\n${writeManifest}`);
  const run = new Function("Bun", "existsSync", "statSync", "dirname", "join", "resolve", "here", "out", "process", `return (async () => { ${body} })();`);
  const here = join(root, "sandbox"), out = join(root, "output");
  await mkdir(out, { recursive: true });
  await run(Bun, existsSync, statSync, dirname, join, resolve, here, out, { env: {} });
  return out;
}

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
test("sandbox stages matching QuickJS side gzip and manifest with the core", async () => {
  const root = await scratch();
  const { core, side } = quickjsPair();
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/bun.wasm"), core);
  await writeFile(join(root, "dist/quickjs.wasm"), side);
  const out = await sandboxAssets(root);
  expect(Bun.gunzipSync(await readFile(join(out, "bun.wasm.gz")))).toEqual(core);
  expect(Bun.gunzipSync(await readFile(join(out, "quickjs.wasm.gz")))).toEqual(side);
  expect(JSON.parse(await readFile(join(out, "engine-builds.json"), "utf8"))).toEqual({ "bun.wasm": digest(core), "quickjs.wasm": digest(side) });
  await rm(join(root, "dist/quickjs.wasm"));
  await expect(sandboxAssets(root)).rejects.toThrow("matching side module");
});

test("Node retains distinct pair associations through selected child module lookup", async () => {
  const root = await scratch();
  const { core, side } = quickjsPair();
  const sideB = Uint8Array.from(Array.from(side).concat([0, 2, 1, 120]));
  for (const [name, bytes] of [["a", side], ["b", sideB]] as const) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "bun.wasm"), core);
    await writeFile(join(root, name, "quickjs.wasm"), bytes);
  }
  const first = await loadNodeProgram(join(root, "a/bun.wasm"));
  const second = await loadNodeProgram(join(root, "b/bun.wasm"));
  expect(first.module).not.toBe(second.module);
  expect((await loadNodeProgram(join(root, "a/bun.wasm"))).module).toBe(first.module);
  const programs = new Map([[first.module, first.linkPlan], [second.module, second.linkPlan]]);
  expect(programs.get(first.module)?.libraries[0]?.source).toEqual(side);
  expect(programs.get(second.module)?.libraries[0]?.source).toEqual(sideB);
  const { createNodeExecutableRegistry } = await import("../scripts/node-spawn");
  await mkdir(join(root, "opt/bun/quickjs/bin"), { recursive: true });
  await writeFile(join(root, "opt/bun/quickjs/bin/bun"), new Uint8Array());
  const registry = createNodeExecutableRegistry(first.module, { "/": root }, { quickjs: second.module });
  const child = await registry.resolve("/opt/bun/quickjs/bin/bun");
  expect(child.module).toBe(second.module);
  expect(programs.get(child.module)?.libraries[0]?.source).toEqual(sideB);
  const ordinaryBytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  await writeFile(join(root, "ordinary.wasm"), ordinaryBytes);
  const ordinary = await loadNodeProgram(join(root, "ordinary.wasm"));
  expect(ordinary.linkPlan).toBeUndefined();
  expect(programs.has(ordinary.module)).toBe(false);
});
