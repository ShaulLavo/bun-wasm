import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { sandbox, helper, worker, instrumentRouter, instrumentConsumerPreview, providerPrelude, networkProjection, sha } from "./transforms";
import { repo, root, evidence, source, original, staged } from "./paths";
import { verifySite } from "../../../scripts/browser-guest-site.ts";

assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), source.head);
const before = verifySite(original);
const report = import.meta.dir;
const diagnosticInputs = await Promise.all((await readdir(report, { recursive: true })).sort().filter(name => !name.endsWith("/source")).map(async name => {
  const file = Bun.file(join(report, name));
  if (!(await file.exists())) return null;
  const stat = await import("node:fs/promises").then(fs => fs.stat(file.name!));
  if (!stat.isFile()) return null;
  return { name, sha256: sha(await file.bytes()) };
}));
const build = sha(JSON.stringify({ source, diagnosticInputs }));
const routerPath = join(repo, "web/node_modules/waffle/browser/preview.ts");
const prelude = providerPrelude(await readFile(routerPath, "utf8"));
const edits: Array<{ path: string; originalSha256: string; transformedSha256: string; contents: string }> = [];
async function originalSource(path: string, text: string) {
  const relative = path.slice(repo.length + 1);
  if (relative.includes("node_modules/")) return;
  assert.equal(text, execFileSync("git", ["show", `${source.head}:${relative}`], { cwd: repo, encoding: "utf8" }));
}
async function load(path: string) {
  const originalText = await readFile(path, "utf8");
  await originalSource(path, originalText);
  let text: string;
  if (path.endsWith("/sandbox/src/main.ts")) text = `import ${JSON.stringify(join(report, "collector.ts"))};\n` + originalText;
  else if (path.endsWith("/sandbox/src/sandbox.ts")) text = sandbox(originalText, prelude);
  else if (path.endsWith("/web/src/preview.ts")) text = instrumentConsumerPreview(originalText);
  else if (path.endsWith("/web/src/sw.ts")) text = `import ${JSON.stringify(join(report, "collector.ts"))};\n` + originalText;
  else if (path.endsWith("/waffle/browser/preview.ts")) text = instrumentRouter(originalText);
  else if (path.endsWith("/waffle/browser/service-worker.ts")) text = worker(originalText);
  else if (path.endsWith("/waffle/browser/net/helper.ts")) text = helper(originalText, prelude);
  else if (path.endsWith("/waffle/browser/net/runtime.ts")) text = networkProjection(originalText, prelude);
  else return;
  edits.push({ path, originalSha256: sha(originalText), transformedSha256: sha(text), contents: text });
  return { contents: text, loader: "ts" as const };
}
function configure(build: Parameters<Bun.BunPlugin["setup"]>[0]) {
  build.onLoad({ filter: /(?:\/sandbox\/src\/(?:main|sandbox)|\/web\/src\/(?:sw|preview)|\/waffle\/browser\/(?:preview|service-worker|net\/(?:helper|runtime)))\.ts$/ }, ({ path }) => load(path));
}
const plugin: Bun.BunPlugin = { name: "original-storage-preview-routing", setup: configure };
const originalBuild = Bun.build;
Bun.build = function(config) {
  return Reflect.apply(originalBuild, Bun, [{ ...config, define: { ...config.define, __STORAGE_ROUTING_BUILD__: JSON.stringify(build) }, plugins: (config.plugins ?? []).concat([plugin]) }]);
};
for (const name of ["BUN_WASM", "JSC_WASM", "BUN_BROWSER_WASM", "BUN_TOOLS_WASM", "BASH_WEB_GUESTS_DIR"]) process.env[name] = join(root, "deliberately-absent", name);
delete process.env.BASH_WEB_GUESTS;
try { await import(join(repo, "sandbox/build.ts")); }
finally { Bun.build = originalBuild; await Bun.write(join(evidence, "BUILD-INTERCEPTION.json"), JSON.stringify(edits, null, 2)); }
await cp(join(original, "site"), staged, { recursive: true, errorOnExist: true });
const output = join(repo, "sandbox/dist");
const target = join(staged, "sandbox");
for (const name of await readdir(output, { recursive: true })) {
  if (!name.endsWith(".js") && !name.endsWith(".js.map")) continue;
  // The original shell and every other worker remain the exact producer bytes.
  if (name.endsWith("shell-worker.js") || name.endsWith("shell-worker.js.map")) continue;
  await Bun.write(join(target, name), Bun.file(join(output, name)));
}
const preserved = [];
for (const [name, expected] of Object.entries(before.files)) {
  const changedJS = name.startsWith("sandbox/") && (name.endsWith(".js") || name.endsWith(".js.map")) && !name.includes("shell-worker.js");
  if (changedJS) continue;
  assert.equal(sha(await Bun.file(join(staged, name)).bytes()), expected, `original asset ${name}`);
  preserved.push({ name, sha256: expected });
}
for (const name of ["index.html", "engine-builds.json"]) assert.deepEqual(await Bun.file(join(target, name)).bytes(), await Bun.file(join(original, "site/sandbox", name)).bytes());
const sw = await Bun.file(join(target, "sw.js")).bytes();
const old = await Bun.file(join(original, "site/sandbox/sw.js")).bytes();
await Bun.write(join(evidence, "original-sw.js.gz"), Bun.gzipSync(old));
await Bun.write(join(evidence, "instrumented-sw.js.gz"), Bun.gzipSync(sw));
assert.notEqual(sha(sw), sha(old));
assert(new TextDecoder().decode(sw).includes(build));
for (const name of await readdir(join(target, "__bunwasm"), { recursive: true })) {
  if (!name.endsWith(".js")) continue;
  assert.deepEqual(await Bun.file(join(target, "__bunwasm", name)).bytes(), await Bun.file(join(target, name)).bytes());
}
assert(edits.some(edit => edit.path.endsWith("/waffle/browser/net/helper.ts")));
assert.deepEqual(verifySite(original), before);
assert.equal(execFileSync("git", ["diff", "--exit-code"], { cwd: repo, encoding: "utf8" }), "");
await Bun.write(join(evidence, "BUILD.json"), JSON.stringify({ source, build, diagnosticInputs, original, staged, preserved, sw: { originalSha256: sha(old), instrumentedSha256: sha(sw), bytes: sw.length },
  originalCaller: "sandbox/tests/storage-browser.ts:preservationScenario", originalClaimTimeout: 3000, wasmRebuilt: false, shell: "Exact original shell guest and worker bytes, no fabricated receipt" }, null, 2));
