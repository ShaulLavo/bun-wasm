import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { sandboxModel, replaceOnce } from "./transforms.ts";
import { repo, root, evidence, source, original, staged } from "./paths.ts";
import { verifySite } from "../../../scripts/browser-guest-site.ts";

assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), source.head);
const before = verifySite(original);
const hash = (value: string | Uint8Array) => Bun.SHA256.hash(value, "hex");
const report = import.meta.dir;
const edits: Array<{ path: string; originalSha256: string; transformedSha256: string; contents: string }> = [];
function bunEntry(original: string) {
  let text = `import { observeClient, wrapExecutor } from ${JSON.stringify(join(report, "endpoint.ts"))};\n` + original;
  text = replaceOnce(text, "const request = event.data;", "const request = event.data; const endpoint = observeClient(request, 'bun');");
  return replaceOnce(text, "await bootstrap(request, executor, host);", "await bootstrap(request, wrapExecutor(executor, endpoint), host);");
}
function shellEntry(original: string) {
  const text = `import { observeClient, wrapExecutor } from ${JSON.stringify(join(report, "endpoint.ts"))};\n` + original;
  return replaceOnce(text, "host.onmessage = (event) => bootstrap(event.data, shellExecutor(event.data));", "host.onmessage = (event) => { const endpoint = observeClient(event.data, 'shell'); return bootstrap(event.data, wrapExecutor(shellExecutor(event.data), endpoint)); };");
}
async function load(path: string) {
  const originalText = await readFile(path, "utf8");
  let text: string;
  if (path === join(repo, "sandbox/src/main.ts")) text = `import ${JSON.stringify(join(report, "collector.ts"))};\n` + originalText;
  else if (path === join(repo, "sandbox/src/sandbox.ts")) text = sandboxModel(originalText, report);
  else if (path === join(repo, "web/src/worker.ts")) text = bunEntry(originalText);
  else if (path === join(repo, "web/src/bun-executor.ts")) text = `import { browserExecutorEntry } from ${JSON.stringify(join(report, "endpoint.ts"))};\n` + replaceOnce(originalText, "      return startEngineHost({", "      browserExecutorEntry(req);\n      return startEngineHost({");
  else if (path === join(repo, "web/src/fs-worker.ts")) text = `import ${JSON.stringify(join(report, "service-prelude.ts"))}; import "waffle/browser/fs-worker";`;
  else if (path.endsWith("/bash-web/src/runtime/worker.ts")) text = shellEntry(originalText);
  else return;
  edits.push({ path, originalSha256: hash(originalText), transformedSha256: hash(text), contents: text });
  return { contents: text, loader: "ts" as const };
}
const plugin: Bun.BunPlugin = { name: "storage-firefox-native-observer", setup(build) {
  build.onLoad({ filter: /(?:\/sandbox\/src\/(?:main|sandbox)|\/web\/src\/(?:worker|bun-executor|fs-worker)|\/bash-web\/src\/runtime\/worker)\.ts$/ }, ({ path }) => load(path));
} };
const originalBuild = Bun.build;
Bun.build = function (config) {
  return Reflect.apply(originalBuild, Bun, [{ ...config, plugins: (config.plugins ?? []).concat([plugin]) }]);
};
for (const name of ["BUN_WASM", "JSC_WASM", "BUN_BROWSER_WASM", "BUN_TOOLS_WASM", "BASH_WEB_GUESTS_DIR"]) process.env[name] = join(root, "deliberately-absent-test-build-input", name);
delete process.env.BASH_WEB_GUESTS;
try { await import(join(repo, "sandbox/build.ts")); }
finally { Bun.build = originalBuild; await Bun.write(join(evidence, "BUILD-INTERCEPTION.json"), JSON.stringify(edits, null, 2)); }
await cp(join(original, "site"), staged, { recursive: true, errorOnExist: true });
const output = join(repo, "sandbox/dist");
const target = join(staged, "sandbox");
assert.deepEqual(await Bun.file(join(output, "sw.js")).bytes(), await Bun.file(join(target, "sw.js")).bytes());
for (const name of await readdir(output, { recursive: true })) {
  if (!name.endsWith(".js") && !name.endsWith(".js.map")) continue;
  await Bun.write(join(target, name), Bun.file(join(output, name)));
}
const preserved = [];
for (const [name, expected] of Object.entries(before.files)) {
  if (name.endsWith(".js") || name.endsWith(".js.map")) continue;
  const bytes = await Bun.file(join(staged, name)).bytes();
  assert.equal(hash(bytes), expected, `unchanged original site asset ${name}`);
  preserved.push({ name, bytes: bytes.byteLength, sha256: expected });
}
for (const name of ["index.html", "engine-builds.json", "sw.js"]) assert.deepEqual(await Bun.file(join(target, name)).bytes(), await Bun.file(join(original, "site/sandbox", name)).bytes());
for (const name of await readdir(join(target, "__bunwasm"), { recursive: true })) {
  if (name.endsWith(".js")) assert.deepEqual(await Bun.file(join(target, "__bunwasm", name)).bytes(), await Bun.file(join(target, name)).bytes());
}
assert(edits.find(edit => edit.path === join(repo, "sandbox/src/main.ts"))?.contents.endsWith(await readFile(join(repo, "sandbox/src/main.ts"), "utf8")));
assert.equal(execFileSync("git", ["diff", "--exit-code"], { cwd: repo, encoding: "utf8" }), "");
assert.deepEqual(verifySite(original), before);
await Bun.write(join(evidence, "BUILD.json"), JSON.stringify({ source, original, staged, preserved, originalMainPreserved: true, originalServiceWorkerAndHTMLPreserved: true,
  unchangedArtifactConsumption: true, noBashReceiptFabricated: true, shellJavaScriptSource: "e6d29598eb0111f16bc3068ad52a9167dac51da7", guestBuild: false }, null, 2));
