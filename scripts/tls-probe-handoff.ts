import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspectProbeLinkMap } from "./tls-probe-symbols.ts";
import { verifyCryptoRecord } from "./tls-probe-cargo.ts";
import { atomicJson, checkedTool, contained, digest, fileIdentity, object, tlsContext, type TlsContext } from "./tls-probe-inputs.ts";
import { objectAbi } from "./tls-probe-archives.ts";

const tlsHandoffFiles = ["cargo/host.json", "cargo/wasm32-wasip1.json", "output/tls-probe.wasm", "output/crypto-only.wasm", "output/tls-probe-native", "output/tls.map", "output/symbols.json", "output/commands.jsonl", "output/compiled-hashes.json", "output/sizes.json", "output/source-proof.json"];
function evidence(path: string, limit = 1024 * 1024): Buffer {
  assert.ok(statSync(path).size <= limit, `TLS proof exceeds byte bound: ${path}`);
  return readFileSync(path);
}

export function probeLinks(context: TlsContext, host: Awaited<ReturnType<typeof verifyCryptoRecord>>, wasi: typeof host, root: string) {
  const output = join(root, "output");
  const source = join(context.workspace, "tests/native/tls-probe.cpp");
  const common = ["-O2", "-fno-exceptions", "-fno-rtti", "-I" + join(context.source, "include"), source];
  const wasm = ["--target=wasm32-wasip1", `--sysroot=${context.sysroot}`].concat(common);
  const archives = [wasi.archives.ssl, wasi.archives.crypto, `-L${context.sysroot}/lib/wasm32-wasip1/noeh`, `-L${context.sysroot}/lib/wasm32-wasip1`, "-lc++", "-lc++abi"];
  return [
    { executable: checkedTool(context, "cxx"), args: wasm.concat(archives, ["-Wl,-Map=" + join(output, "tls.map"), "-o", join(output, "tls-probe.wasm")]), output: "tls-probe.wasm" },
    { executable: checkedTool(context, "cxx"), args: wasm.concat(["-DTLS_PROBE_BASELINE"], archives, ["-o", join(output, "crypto-only.wasm")]), output: "crypto-only.wasm" },
    { executable: checkedTool(context, "hostCxx"), args: common.concat([host.archives.ssl, host.archives.crypto, "-lpthread", "-o", join(output, "tls-probe-native")]), output: "tls-probe-native" },
  ];
}
export function verifyTlsMap(context: TlsContext, map: string) {
  const symbols = inspectProbeLinkMap(map);
  for (const paths of Object.values(symbols)) {
    for (const path of paths) assert.ok(contained(context.sysroot, realpathSync(path)) || contained(context.sdk, realpathSync(path)), `Foreign TLS runtime archive: ${path}`);
  }
  return symbols;
}

export async function sealTlsHandoff(root: string, context: TlsContext): Promise<string> {
  await verifyTlsPayload(root, context);
  const files = await Promise.all(tlsHandoffFiles.map(async path => ({ ...await fileIdentity(join(root, path)), path })));
  const receipt = { schema: 1, context, files };
  atomicJson(join(root, "handoff.json"), receipt);
  return (await fileIdentity(join(root, "handoff.json"))).sha256;
}
export async function verifyTlsHandoff(root: string, expectedDigest: string, context: TlsContext): Promise<string> {
  assert.match(expectedDigest, /^[0-9a-f]{64}$/, "expected digest must come from the producer output");
  const bytes = evidence(join(root, "handoff.json"));
  assert.equal(digest(bytes), expectedDigest, "TLS producer digest mismatch");
  const receipt: unknown = JSON.parse(bytes.toString());
  assert.ok(object(receipt) && receipt.schema === 1, "malformed TLS producer handoff");
  assert.deepEqual(receipt.context, context, "TLS run/source/tool/profile/sysroot context mismatch");
  const files = await Promise.all(tlsHandoffFiles.map(async path => ({ ...await fileIdentity(join(root, path)), path })));
  assert.deepEqual(receipt.files, files, "TLS artifact/map/command proof changed");
  return verifyTlsPayload(root, context);
}
async function verifyTlsPayload(root: string, context: TlsContext): Promise<string> {
  const host = await verifyCryptoRecord(join(root, "cargo/host.json"), context, "host");
  const wasi = await verifyCryptoRecord(join(root, "cargo/wasm32-wasip1.json"), context, "wasm32-wasip1");
  const plan = probeLinks(context, host, wasi, root);
  const commands = evidence(join(root, "output/commands.jsonl")).toString().trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(commands, plan, "TLS executable commands do not match selected archives/compiler/profile");
  const hashes = JSON.parse(evidence(join(root, "output/compiled-hashes.json")).toString());
  assert.deepEqual(hashes, await Promise.all(plan.map(link => fileIdentity(join(root, "output", link.output)))), "compiled link hashes missing or stale");
  for (const name of ["tls-probe.wasm", "crypto-only.wasm"]) objectAbi(readFileSync(join(root, "output", name)).subarray(0, 64), "wasm32-wasip1");
  objectAbi(readFileSync(join(root, "output/tls-probe-native")).subarray(0, 64), "host");
  const symbols = verifyTlsMap(context, evidence(join(root, "output/tls.map"), 32 * 1024 * 1024).toString());
  assert.deepEqual(JSON.parse(evidence(join(root, "output/symbols.json")).toString()), symbols, "TLS symbol proof does not match full map");
  const provenance: unknown = JSON.parse(evidence(join(root, "output/source-proof.json")).toString());
  assert.ok(object(provenance), "malformed upstream provenance");
  assert.equal(provenance.pin, context.pin);
  assert.equal(provenance.sourceInputs, context.upstream);
  assert.equal(provenance.url, `https://codeload.github.com/oven-sh/boringssl/tar.gz/${context.pin}`);
  assert.ok(typeof provenance.archiveSha256 === "string" && /^[0-9a-f]{64}$/.test(provenance.archiveSha256), "missing pinned archive identity");
  return join(root, "output/tls-probe.wasm");
}
export function requireTrustedProbe(output: string | undefined): Promise<string> {
  if (!output) throw new Error("BUNWASM_TLS_PROBE_OUTPUT is required; selected G0 cannot skip missing evidence");
  const expected = process.env.BUNWASM_TLS_PROBE_SHA256;
  assert.ok(expected, "TLS digest must be supplied by the producing job, not the receipt directory");
  return tlsContext().then(context => {
    assert.equal(output, join(context.target, "tls-probe/output"));
    return verifyTlsHandoff(join(context.target, "tls-probe"), expected, context);
  });
}
