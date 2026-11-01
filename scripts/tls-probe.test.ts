import { inspectProbeLinkMap } from "./tls-probe-symbols.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspectProbe, qualifyProbe, requireProbeEvidence } from "./tls-probe.ts";

test("selected TLS G0 fails closed without build evidence", () => {
  expect(() => requireProbeEvidence(undefined)).toThrow("cannot skip missing evidence");
  expect(() => requireProbeEvidence("/missing-tls-probe-evidence")).toThrow();
});

test("TLS G0 runs verified handshakes and live failure controls", async () => {
  const output = process.env.BUNWASM_TLS_PROBE_OUTPUT;
  const binary = requireProbeEvidence(output);
  if (!output) throw new Error("Missing output");
  const imports = await inspectProbe(binary);
  const result = await qualifyProbe(binary, output);
  expect(result.results.map(item => item.name)).toEqual(["tls12-valid", "tls13-valid", "unknown-ca-rejected", "expired-peer-rejected", "hostname-rejected"]);
  writeFileSync(join(output, "result.json"), JSON.stringify({ imports, ...result }, null, 2) + "\n");
}, 180_000);

test("link map checks reject duplicate C runtimes and missing TLS symbols", () => {
  const map = [
    "/sdk/lib/wasm32-wasip1/libc.a(dlmalloc.o):(dlmalloc)",
    "/sdk/lib/wasm32-wasip1/noeh/libc++.a(string.cpp.o):(string)",
    "/build/libssl.a(ssl_lib.cc.obj):(SSL_do_handshake)",
    "/build/libssl.a(ssl_x509.cc.obj):(SSL_get_verify_result)",
    "/sdk/lib/wasm32-wasip1/libc.a(getentropy.o):(getentropy)",
  ].join("\n");
  expect(inspectProbeLinkMap(map)["libc.a"]).toEqual(["/sdk/lib/wasm32-wasip1/libc.a"]);
  expect(() => inspectProbeLinkMap(map + "\n/other/libc.a(malloc.o):(malloc)")).toThrow("one linked libc.a");
  expect(() => inspectProbeLinkMap(map.replace("(SSL_do_handshake)", "(missing)"))).toThrow("one linked SSL_do_handshake");
  expect(() => inspectProbeLinkMap(map + "\n__cxa_allocate_exception")).toThrow("exception-enabled");
});


test("build evidence does not accept arbitrary result booleans", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-tls-evidence-"));
  try {
    writeFileSync(join(scratch, "build.json"), JSON.stringify({ controls: { valid: true, randomGetImported: true, entropyFailureNonzero: true } }));
    writeFileSync(join(scratch, "tls-probe.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => requireProbeEvidence(scratch)).toThrow();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
