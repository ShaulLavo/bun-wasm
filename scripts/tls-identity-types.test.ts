import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function checkTypes(probe: string): { status: number | null; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-tls-identity-types-"));
  try {
    const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
    const source = readFileSync(new URL("tls_identity.ts", runtime), "utf8");
    const path = join(scratch, "probe.ts");
    writeFileSync(path, source.replace("(function (internal:", "const factory = (function (internal:") + `;\n${probe}`);
    const config = join(scratch, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
      compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, target: "ES2022", module: "Preserve", moduleResolution: "bundler", lib: ["ES2022"], types: [] },
      files: [fileURLToPath(new URL("tls_identity_types.d.ts", runtime)), path],
    }));
    const compiler = process.env.BUN_WASM_IDENTITY_TSC ?? fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
    const result = spawnSync(compiler, ["-p", config, "--pretty", "false"], { encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the actual IIFE and its declared boundary pass strict checked-index types", () => {
  const result = checkTypes(`
declare const hooks: BunWasm.TlsIdentityInternal;
const module: BunWasm.TlsIdentity = factory(hooks);
const peer: BunWasm.TlsPeerCertificate = { subject: { CN: ["example.com"] }, subjectaltname: "DNS:example.com" };
module.checkServerIdentity("example.com", peer);
const decision: BunWasm.TlsIdentityDecision = module.verifyIdentity({ chainVerified: false, authorizationError: new Error("chain"), rejectUnauthorized: true });
if (decision.kind !== "authorized") decision.authorizationError.message;
`);
  expect(result.status, result.output).toBe(0);
});

test("a failed chain cannot carry a custom identity callback or an authorized failure state", () => {
  const result = checkTypes(`
const failed: BunWasm.TlsIdentityVerification = { chainVerified: false, authorizationError: new Error("chain"), rejectUnauthorized: true, checkServerIdentity: () => undefined };
const accepted: BunWasm.TlsIdentityDecision = { kind: "authorized", authorizationError: new Error("chain") };
const ip: BunWasm.TlsIdentityTarget = { kind: "ip", hostname: "192.0.2.1", servername: "192.0.2.1" };
`);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("checkServerIdentity");
  expect(result.output).toContain("authorizationError");
  expect(result.output).toContain("servername");
});
