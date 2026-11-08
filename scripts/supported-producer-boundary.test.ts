import { expect, test } from "bun:test";
import { engineEnvironment, inputProfile, parseProgramInputs, parseProgramReceipt, verifyProgramReceipt } from "./guest-core-receipt.ts";
import { hash } from "./guest-source-manifest.ts";
import { producerEngines, producerScopes, publicationEngines } from "./producer-closure.ts";
import { parseProgramFiles, type PairedEngine, type SupportedPairedEngine } from "../src/engine-kind.ts";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";

function snapshot(scope: string, content: unknown = { selection: { kind: scope } }) {
  return { schema: 1, scope, source: { head: "a".repeat(40), tree: "b".repeat(40) }, content, contentSha256: hash(JSON.stringify(content)) };
}

function receipt(scope: PairedEngine) {
  const { side } = quickjsPair(scope);
  return { schema: 1, inputs: snapshot(scope), artifact: { artifactSha256: hash(side), artifactBytes: side.byteLength } };
}

function cli(script: string, args: string[]) {
  return Bun.spawnSync([process.execPath, `${import.meta.dir}/${script}.ts`].concat(args), {
    env: { ...process.env, BUN_WASM_SYSROOT: "/synthetic-supported-boundary-sysroot" },
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
}

test("normal snapshots reject an opt-in host engine", () => {
  expect(() => parseProgramInputs(snapshot("spidermonkey"))).toThrow("Invalid program input snapshot");
});

test("normal receipts reject an opt-in host engine", () => {
  expect(() => parseProgramReceipt(receipt("spidermonkey"))).toThrow("Invalid program input snapshot");
});

test("normal supported snapshots, receipt bytes and profiles stay unchanged", () => {
  for (const kind of ["quickjs", "jsc"] as const) {
    const inputs = snapshot(kind);
    expect(JSON.stringify(parseProgramInputs(inputs))).toBe(JSON.stringify(inputs));
    const original = receipt(kind);
    expect(JSON.stringify(verifyProgramReceipt(quickjsPair(kind).side, original, parseProgramInputs(inputs)))).toBe(JSON.stringify(original));
    expect(inputProfile(parseProgramInputs(inputs))).toBe("split");
  }
  const shared = snapshot("quickjs", { selection: { kind: "quickjs", profile: "shared-group" } });
  expect(inputProfile(parseProgramInputs(shared))).toBe("shared-group");
  expect(parseProgramInputs(snapshot("core")).scope).toBe("core");
});

test("normal receipt validation retains content, byte and profile rejection", () => {
  const inputs = parseProgramInputs(snapshot("quickjs"));
  const original = receipt("quickjs");
  expect(() => parseProgramInputs({ ...inputs, contentSha256: "0".repeat(64) })).toThrow("Invalid program input snapshot");
  expect(() => verifyProgramReceipt(quickjsPair().side, { ...original, artifact: { ...original.artifact, artifactBytes: 8 } }, inputs)).toThrow("artifact bytes");
  const shared = parseProgramInputs(snapshot("quickjs", { selection: { kind: "quickjs", profile: "shared-group" } }));
  expect(() => verifyProgramReceipt(quickjsPair().side, original, shared)).toThrow("Program profile mismatch");
});

test("normal producer scope types and values remain supported-only", () => {
  const engines: readonly SupportedPairedEngine[] = producerEngines("split");
  const scopes: readonly ("core" | SupportedPairedEngine)[] = producerScopes("split");
  const published: readonly (SupportedPairedEngine | "browser")[] = publicationEngines;
  expect(engines).toEqual(["quickjs", "jsc"]);
  expect(scopes).toEqual(["core", "quickjs", "jsc"]);
  expect(published).toEqual(["quickjs", "jsc", "browser"]);
  expect(producerScopes("shared-group")).toEqual(["core", "quickjs"]);
});

test("receipt CLI rejects unsupported engine scope before accessing inputs or files", () => {
  for (const command of ["environment", "inputs"]) {
    const result = cli("guest-engine-receipt", [command, "spidermonkey"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Usage: guest-engine-receipt.ts");
    expect(result.stdout.toString()).toBe("");
  }
  const tag = cli("guest-core-receipt", ["tag", "/nonexistent-boundary-core", "spidermonkey", "/nonexistent-boundary-output"]);
  expect(tag.exitCode).not.toBe(0);
  expect(tag.stderr.toString()).toContain("Usage: guest-core-receipt.ts");
});

test("supported CLI environments retain the normal generated flags", () => {
  for (const kind of ["quickjs", "jsc"] as const) {
    const result = cli("guest-engine-receipt", ["environment", kind]);
    expect(result.exitCode).toBe(0);
    const flags = engineEnvironment(kind, "/synthetic-supported-boundary-sysroot");
    const exports = Object.entries(flags).map(([key, value]) => `export ${key}='${value}'`).join("\n");
    expect(result.stdout.toString()).toBe(`unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS\n${exports}\n`);
  }
});

test("explicit opt-in SpiderMonkey ProgramFiles parsing remains valid", () => {
  expect(parseProgramFiles({ kind: "spidermonkey", core: "core", side: "side" }, value => {
    if (typeof value !== "string") throw new Error("Expected synthetic path");
    return value;
  })).toEqual({ kind: "spidermonkey", core: "core", side: "side" });
});

test("explicit initializer CLI rejects opt-in engine before reading inputs or writing output", () => {
  const result = cli("src/engine-explicit-init", ["spidermonkey", "/nonexistent-boundary-side", "/nonexistent-boundary-output"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("usage: engine-explicit-init.ts quickjs|jsc|core");
  expect(result.stderr.toString()).not.toContain("ENOENT");
  expect(result.stdout.toString()).toBe("");
});
