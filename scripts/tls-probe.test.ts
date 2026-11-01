import { inspectProbeLinkMap } from "./tls-probe-symbols.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertRejection, requireProbeEvidence } from "./tls-probe.ts";

test("selected TLS G0 fails closed without build evidence", () => {
  expect(() => requireProbeEvidence(undefined)).toThrow("cannot skip missing evidence");
  expect(() => requireProbeEvidence("/missing-tls-probe-evidence")).toThrow();
});


test("link map checks reject duplicate C runtimes and missing TLS symbols", () => {
  const map = [
    "/sdk/lib/wasm32-wasip1/libc.a(dlmalloc.o):(dlmalloc)",
    "/sdk/lib/wasm32-wasip1/noeh/libc++.a(string.cpp.o):(string)",
    "/build/libssl.a(ssl_lib.cc.obj):(SSL_do_handshake)",
    "/build/libssl.a(ssl_x509.cc.obj):(SSL_get_verify_result)",
    "/sdk/lib/wasm32-wasip1/libc.a(__wasilibc_real.c.obj):(__wasi_random_get)",
    "/sdk/lib/wasm32-wasip1/libc.a(getentropy.c.obj):(__getentropy)",
    "       -      14e       32                 getentropy",
  ].join("\n");
  expect(inspectProbeLinkMap(map)["libc.a"]).toEqual(["/sdk/lib/wasm32-wasip1/libc.a"]);
  expect(() => inspectProbeLinkMap(map + "\n/other/libc.a(malloc.o):(malloc)")).toThrow("one linked libc.a");
  expect(() => inspectProbeLinkMap(map.replace("(SSL_do_handshake)", "(missing)"))).toThrow("one linked SSL_do_handshake");
  expect(() => inspectProbeLinkMap(map + "\n__cxa_allocate_exception")).toThrow("exception-enabled");
  expect(() => inspectProbeLinkMap(map.replace("(__getentropy)", "(missing)"))).toThrow("one linked __getentropy");
  expect(() => inspectProbeLinkMap(map.replace("(__wasi_random_get)", "(missing)"))).toThrow("one linked __wasi_random_get");
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

test("certificate rejection requires a terminal zero-byte observation", () => {
  const test = { verify: 20 };
  expect(() => assertRejection(test, "rejected verify=20\n", "")).toThrow();
  expect(() => assertRejection(test, "rejected verify=20\n", "terminal applicationBytes=0\n")).not.toThrow();
});

test("certificate rejection catches the first byte and a delayed full payload", () => {
  const test = { verify: 20 };
  expect(() => assertRejection(test, "rejected verify=20\n", "application-bytes=1\nterminal applicationBytes=1\n")).toThrow();
  expect(() => assertRejection(test, "rejected verify=20\n", "terminal applicationBytes=17\n")).toThrow();
});
