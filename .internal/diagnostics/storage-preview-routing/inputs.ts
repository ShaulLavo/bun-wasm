import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { repo, root, evidence, source, original, packet } from "./paths.ts";
import { verifyBrowserProgram } from "../../../scripts/ci-browser-program.ts";
import { verifySite } from "../../../scripts/browser-guest-site.ts";

const selected = [
  { id: 14134432845, name: "browser-guest-site", bytes: 146293020, sha256: "2ec603c8c5f73f904a44d9b3ea1c77e7733b800adbd9b9e3db23dd96a894d569" },
  { id: 14134472972, name: "browser-program", bytes: 18191676, sha256: "f903172f61c3d268cfd99ae4fd01bfcf9fa6a663e69646a7015b891d59c2058a" },
];
const records: object[] = [];
for (const input of selected) await restore(input);
const program = await verifyBrowserProgram(packet, source);
execFileSync(process.execPath, [join(repo, "scripts/ci-browser-program.ts"), "verify", packet], { cwd: repo, stdio: "inherit" });
const before = verifySite(original);
execFileSync(process.execPath, [join(repo, "scripts/browser-guest-site.ts"), "verify", original], { cwd: repo, stdio: "inherit" });
for (const name of ["bun-browser.wasm", "bun-tools.wasm"]) {
  assert.deepEqual(Bun.gunzipSync(await Bun.file(join(original, "site", name + ".gz")).bytes()), await Bun.file(join(packet, name)).bytes());
}
const versions = [];
for (const consumer of ["", "web", "sandbox"]) {
  for (const [name, expected] of [["waffle", "0.0.130"], ["waffle-base", "0.0.16"]]) {
    const installed = await Bun.file(join(repo, consumer, "node_modules", name!, "package.json")).json();
    assert.equal(installed.version, expected);
    versions.push({ consumer, name, version: installed.version });
  }
}
assert.equal((await Bun.file(join(repo, "web/node_modules/waffle-relay/package.json")).json()).version, "0.0.130");
assert((await Bun.file(join(repo, "sandbox/package.json")).text()).includes("e6d29598eb0111f16bc3068ad52a9167dac51da7"));
await Bun.write(join(evidence, "ADMISSION.json"), JSON.stringify({ source, run: 43639146916, records, program: program.delivery, originalSite: before, versions,
  shell: "Original CI site's inventory-bound shell, consumed unchanged. No local Bash receipt is asserted. Shell JavaScript uses frozen e6d installed source.", wasmRebuilt: false, jscUsed: false }, null, 2));

async function restore(input: typeof selected[number]) {
  const metadata = JSON.parse(execFileSync("gh", ["api", `repos/ShaulLavo/bun-wasm/actions/artifacts/${input.id}`], { encoding: "utf8" }));
  assert.equal(metadata.expired, false);
  assert.equal(metadata.name, input.name);
  assert.equal(metadata.size_in_bytes, input.bytes);
  assert.equal(metadata.digest, `sha256:${input.sha256}`);
  assert.equal(metadata.workflow_run.head_sha, "f497778f69bb3a9ed399683431aab066a3013b59");
  assert.equal(metadata.workflow_run.id, 43639146916);
  const archive = join(root, input.name + ".zip");
  const writer = Bun.file(archive).writer();
  const child = Bun.spawn(["gh", "api", `repos/ShaulLavo/bun-wasm/actions/artifacts/${input.id}/zip`], { stdout: "pipe", stderr: "inherit" });
  for await (const bytes of child.stdout) writer.write(bytes);
  await writer.end();
  assert.equal(await child.exited, 0);
  assert.equal(Bun.file(archive).size, input.bytes);
  assert.equal(Bun.SHA256.hash(await Bun.file(archive).bytes(), "hex"), input.sha256);
  await mkdir(join(root, input.name));
  execFileSync("unzip", ["-q", archive, "-d", join(root, input.name)]);
  records.push({ ...input, metadata, archiveVerified: true });
  await rm(archive);
}
