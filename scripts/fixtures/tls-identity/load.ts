import type {} from "../../../crates/bunwasm-runtime/src/js/tls_identity_types.d.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { types } from "node:util";
import { runInNewContext } from "node:vm";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is BunWasm.TlsIdentity {
  return isRecord(value) && typeof value.checkServerIdentity === "function" && typeof value.selectTarget === "function" && typeof value.verifyIdentity === "function";
}

function isAddress(value: unknown): value is { isIP(value: string): 0 | 4 | 6 } {
  return isRecord(value) && typeof value.isIP === "function";
}

function runtimeFactory(name: string, compact: boolean): unknown {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-tls-identity-source-"));
  try {
    const root = new URL("../../../", import.meta.url);
    const output = join(scratch, `${name}.js`);
    const args = [fileURLToPath(new URL("scripts/transpile-runtime.ts", root)), fileURLToPath(new URL(`crates/bunwasm-runtime/src/js/${name}.ts`, root)), output];
    const result = spawnSync(compact ? "bun" : "node", compact ? args.concat(["--minify-whitespace"]) : args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "runtime source erasure failed");
    return runInNewContext(readFileSync(output, "utf8"), { URL });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function loadIdentity(compact = false): BunWasm.TlsIdentity {
  const addressFactory = runtimeFactory("net_address", false);
  if (typeof addressFactory !== "function") throw new Error("net_address did not emit a factory");
  const address: unknown = Reflect.apply(addressFactory, undefined, [{ require: () => ({}) }]);
  if (!isAddress(address)) throw new Error("net_address did not return its address predicates");
  const factory = runtimeFactory("tls_identity", compact);
  if (typeof factory !== "function") throw new Error("tls_identity did not emit a factory");
  const internal: BunWasm.TlsIdentityInternal = {
    native: { domainToASCII },
    require(_name: "net_address" | "util") {
      return Object.assign({}, address, { types });
    },
  };
  const result: unknown = Reflect.apply(factory, undefined, [internal]);
  if (!isIdentity(result)) throw new Error("tls_identity did not return its declared exports");
  return result;
}

export function parseCertificate(value: unknown): BunWasm.TlsPeerCertificate {
  if (!isRecord(value)) throw new Error("fixture certificate must be an object");
  const subject = value.subject;
  if (subject !== undefined && !isRecord(subject)) throw new Error("fixture subject must be an object");
  const commonName = isRecord(subject) ? subject.CN : undefined;
  if (commonName !== undefined && typeof commonName !== "string" && !(Array.isArray(commonName) && commonName.every(item => typeof item === "string"))) {
    throw new Error("fixture CN must be a string or string array");
  }
  const altNames = value.subjectaltname;
  if (altNames !== undefined && typeof altNames !== "string") throw new Error("fixture subjectaltname must be a string");
  return { subject: commonName === undefined ? undefined : { CN: commonName }, subjectaltname: altNames };
}
