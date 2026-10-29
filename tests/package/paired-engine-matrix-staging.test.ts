import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { programKind, programProfile, verifyProgramSide, type PairedEngine } from "../../src/engine-kind.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";

const runner = readFileSync(new URL("../../scripts/app-matrix/run.mjs", import.meta.url), "utf8");
const start = runner.indexOf("  artifacts = Object.fromEntries(options.engines.map(engine => {");
const end = runner.indexOf("  if (options.guestReceipt) {", start);
if (start < 0 || end < 0) throw new Error("Missing matrix staging source boundary");
const stage = new Function("root", "scratch", "options", "wasmName", "readFileSync", "writeFileSync", "join", "sha256", "programKind", "programProfile", "verifyProgramSide", `let artifacts;\n${runner.slice(start, end)}\nreturn artifacts;`);
const names = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm", browser: "bun-browser.wasm", hermes: "bun-hermes.wasm" };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(run: (root: string, scratch: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "paired-matrix-staging-"));
  try {
    mkdirSync(join(root, "dist"));
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    for (const kind of ["quickjs", "jsc", "hermes"] as const) {
      const pair = quickjsPair(kind);
      writeFileSync(join(root, "dist", names[kind]), pair.core);
      writeFileSync(join(root, "dist", programProfile(kind).side), pair.side);
    }
    run(root, scratch);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function staged(root: string, scratch: string, engines: readonly PairedEngine[], write = writeFileSync): unknown {
  return stage(root, scratch, { engines }, names, readFileSync, write, join, sha256, programKind, programProfile, verifyProgramSide);
}

function identity(scratch: string, name: string, bytes: Uint8Array) {
  return { path: join(scratch, name), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

for (const kind of ["quickjs", "jsc", "hermes"] as const) test(`matrix source stages only selected ${kind} pair with both byte identities`, () => {
  fixture((root, scratch) => {
    const pair = quickjsPair(kind);
    const side = programProfile(kind).side;
    expect(staged(root, scratch, [kind])).toEqual({ [kind]: { ...identity(scratch, names[kind], pair.core), side: { name: side, ...identity(scratch, side, pair.side) } } });
    expect(readdirSync(scratch).sort()).toEqual([names[kind], side].sort());
    expect(existsSync(join(scratch, programProfile(kind === "jsc" ? "quickjs" : "jsc").side))).toBe(false);
  });
});

test("matrix source rejects missing, wrong-kind and wrongly declared JSC pairs before staging", () => {
  fixture((root, scratch) => {
    const side = join(root, "dist/jsc-engine.wasm");
    rmSync(side);
    expect(() => staged(root, scratch, ["jsc"])).toThrow();
    expect(readdirSync(scratch)).toEqual([]);
    writeFileSync(side, quickjsPair("quickjs").side);
    expect(() => staged(root, scratch, ["jsc"])).toThrow("jsc companion");
    expect(readdirSync(scratch)).toEqual([]);
    writeFileSync(side, quickjsPair("jsc").side);
    writeFileSync(join(root, "dist/bun-jsc.wasm"), quickjsPair("quickjs").core);
    expect(() => staged(root, scratch, ["jsc"])).toThrow("Selected jsc core declares quickjs");
  });
});

for (const name of ["bun-jsc.wasm", "jsc-engine.wasm"]) test(`matrix source rejects changed copied bytes for ${name}`, () => {
  fixture((root, scratch) => {
    const corrupt: typeof writeFileSync = (path, data, options) => {
      writeFileSync(path, data, options);
      if (path === join(scratch, name)) writeFileSync(path, "changed staged artifact");
    };
    expect(() => staged(root, scratch, ["jsc"], corrupt)).toThrow(`Staged artifact identity mismatch: ${name}`);
  });
});

test("matrix source playground union and provenance include every selected fixed side", () => {
  fixture((root, scratch) => {
    const artifacts = staged(root, scratch, ["quickjs", "jsc", "hermes"]);
    const line = runner.split("\n").find(line => line.includes("verifyPlaygroundBuilds(playgroundBuilds,"));
    const companions = runner.split("\n").find(line => line.trimStart().startsWith("companions: "));
    if (!line || !companions) throw new Error("Missing matrix fingerprint/provenance source");
    const observed: unknown[] = [];
    new Function("options", "artifacts", "wasmName", "playgroundBuilds", "verifyPlaygroundBuilds", line)(
      { product: true, hosts: ["playground"], engines: ["quickjs", "jsc", "hermes"] }, artifacts, names, {}, (_build: unknown, expected: unknown) => observed.push(expected));
    const expected: Record<string, string> = {};
    const provenance: Record<string, unknown> = {};
    for (const kind of ["quickjs", "jsc", "hermes"] as const) {
      const { core, side } = quickjsPair(kind);
      expected[names[kind]] = sha256(core);
      expected[programProfile(kind).side] = sha256(side);
      provenance[kind] = { name: programProfile(kind).side, bytes: side.length, sha256: sha256(side) };
    }
    expect(observed).toEqual([expected]);
    const expression = companions.trim().slice("companions: ".length).replace(/,$/, "");
    const actual: unknown = new Function("artifacts", `return ${expression};`)(artifacts);
    expect(actual).toEqual(provenance);
  });
});
