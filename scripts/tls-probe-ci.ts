import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { verifyCryptoRecord } from "./tls-probe-cargo.ts";
import { probeLinks, sealTlsHandoff, verifyTlsMap } from "./tls-probe-handoff.ts";
import { atomicJson, checkedTool, fileIdentity, tlsContext } from "./tls-probe-inputs.ts";
import { authenticateSource } from "./tls-probe.ts";

function command(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
export async function prepareTlsRecording(capture = tlsContext) {
  const target = process.env.CARGO_TARGET_DIR;
  assert.ok(target, "missing private Cargo target");
  mkdirSync(target, { recursive: true });
  const context = await capture();
  const root = join(context.target, "tls-probe");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "cargo"), { recursive: true });
  atomicJson(join(root, "prepared.json"), context);
}
export async function linkTlsCheckpoint(services = { capture: tlsContext, run: command, authenticate: authenticateSource }): Promise<string> {
  const context = await services.capture();
  const root = join(context.target, "tls-probe");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "prepared.json"), "utf8")), context, "TLS inputs changed since producer preparation");
  const host = await verifyCryptoRecord(join(root, "cargo/host.json"), context, "host");
  const wasi = await verifyCryptoRecord(join(root, "cargo/wasm32-wasip1.json"), context, "wasm32-wasip1");
  const output = join(root, "output");
  mkdirSync(output);
  const provenance = services.authenticate(context.source, output);
  atomicJson(join(output, "source-proof.json"), { pin: context.pin, sourceInputs: context.upstream, url: provenance.url, archiveSha256: provenance.archiveSha256 });
  const plan = probeLinks(context, host, wasi, root);
  appendFileSync(join(output, "commands.jsonl"), plan.map(link => JSON.stringify(link) + "\n").join(""));
  const hashes = [];
  for (const link of plan) {
    services.run(link.executable, link.args);
    hashes.push(await fileIdentity(join(output, link.output)));
    atomicJson(join(output, "compiled-hashes.json"), hashes);
  }
  const sizes = [];
  for (const name of ["tls-probe.wasm", "crypto-only.wasm"]) {
    const stripped = join(output, name + ".stripped");
    services.run(checkedTool(context, "wasm-tools"), ["strip", join(output, name), "-o", stripped]);
    const bytes = readFileSync(stripped);
    sizes.push({ name, stripped: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, brotli: brotliCompressSync(bytes).length, sections: services.run(checkedTool(context, "wasm-tools"), ["objdump", stripped]) });
    rmSync(stripped);
  }
  atomicJson(join(output, "sizes.json"), sizes);
  atomicJson(join(output, "symbols.json"), verifyTlsMap(context, readFileSync(join(output, "tls.map"), "utf8")));
  assert.deepEqual(await services.capture(), context, "TLS inputs changed while linking");
  const sha256 = await sealTlsHandoff(root, context);
  const githubOutput = process.env.GITHUB_OUTPUT;
  assert.ok(githubOutput, "TLS handoff needs a producing job output");
  appendFileSync(githubOutput, `tls-sha256=${sha256}\n`);
  return sha256;
}
if (import.meta.main) {
  const [stage] = process.argv.slice(2);
  if (stage === "prepare") await prepareTlsRecording();
  else if (stage === "link") await linkTlsCheckpoint();
  else throw new Error("Usage: tls-probe-ci.ts prepare|link");
}
