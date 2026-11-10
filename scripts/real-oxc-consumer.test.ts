import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCustomSection } from "../src/engine-kind";
import { quickjsPair, sharedQuickjsPair } from "../tests/package/quickjs-plan-fixture";
import { command, oxcFixture, oxcOutputs, oxcTreeVariable, requireOxcEnvironment, requireOxcInputs, requireOxcTree } from "./real-oxc-consumer";
import { selectChecks } from "./test-checks";

function scratch(check: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-oxc-selection-"));
  try { check(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const key of ["NAPI_RS_FORCE_WASI", "SHARED_WASM_CONTROL", "SHARED_WASM_ENTRY", oxcTreeVariable]) {
  test.each(["", "override"])(`the Oxc consumer refuses ${key}=%j`, value => {
    expect(() => requireOxcEnvironment({ [key]: value })).toThrow(`Real Oxc check refuses override: ${key}`);
  });
}

test("Oxc selection fails on missing and mismatched cores and sides, without a producer or install", () => {
  scratch(directory => {
    const program = join(directory, "bun.wasm");
    const launcher = join(directory, "launcher");
    const browser = join(directory, "bun-browser.wasm");
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("ENOENT");
    const split = quickjsPair();
    const group = appendCustomSection(split.core, "dylink.0", new Uint8Array());
    writeFileSync(program, group);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("ENOENT");
    writeFileSync(join(directory, "quickjs.wasm"), split.side);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("different program profiles");
    writeFileSync(program, split.core);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("shared-group pair");
    writeFileSync(program, quickjsPair("jsc").core);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("QuickJS group core");
  });
});

test("a synthetic group requires both remaining inputs and the correct side exports", () => {
  scratch(directory => {
    const { core, side } = sharedQuickjsPair();
    const program = join(directory, "bun.wasm");
    const launcher = join(directory, "launcher");
    const browser = join(directory, "bun-browser.wasm");
    const sidePath = join(directory, "quickjs.wasm");
    writeFileSync(program, core);
    writeFileSync(sidePath, side);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("ENOENT");
    writeFileSync(launcher, "synthetic input validator fixture, never executed");
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("ENOENT");
    writeFileSync(browser, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => requireOxcInputs(program, launcher, browser)).not.toThrow();
    const mismatched = Buffer.from(side);
    mismatched[mismatched.indexOf("quickjs_run")] = 106;
    writeFileSync(sidePath, mismatched);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("initializer/RUN");
  });
});

test("the installed-tree check refuses changed fixture bytes and a missing official package", () => {
  scratch(directory => {
    cpSync(oxcFixture, directory, { recursive: true });
    expect(() => requireOxcTree(directory)).toThrow("ENOENT");
    writeFileSync(join(directory, "bun.lock"), "a rewritten host lock");
    expect(() => requireOxcTree(directory)).toThrow("Oxc fixture changed: bun.lock");
  });
});

test("the installed-tree check refuses an unselected version of the official binding", () => {
  scratch(directory => {
    cpSync(oxcFixture, directory, { recursive: true });
    for (const name of ["oxc-parser", "@oxc-parser/binding-wasm32-wasi"]) {
      const packageRoot = join(directory, "node_modules", name);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, version: name === "oxc-parser" ? "0.94.0" : "0.93.0" }));
    }
    expect(() => requireOxcTree(directory)).toThrow("Expected published @oxc-parser/binding-wasm32-wasi@0.94.0");
  });
});

test("the real-package controls retain their exact output and source-check owners", () => {
  expect(oxcOutputs).toEqual({ "index.ts": "ExportNamedDeclaration 0\n", "direct.ts": "official Wasm binding loaded function\nshared memory created\n" });
  expect(selectChecks("web")).toContain("scripts/fixture-tree.test.ts");
  expect(selectChecks("quality")).toContain("scripts/real-oxc-consumer.test.ts");
});

// Filled from the authoritative retained fixture, not a host-generated install.
const fixtureHashes: Record<string, string> = {
  "package.json": "a83d9edadbb9ca8c9a0623b5bb8790d23019a3a2dbcda9c1f53791e4bfd08a73",
  "bun.lock": "84b6cc21285cbbc1510d67b23f895eb9ae4f2af9d6d0e42b7594d194bbee836d",
  "index.ts": "31f45b2bee0e7f2aaf1ae6a212b915641714c6ab4b73cdd386a8ed0b8ac251ce",
  "direct.ts": "9d66a50ab5d345e67bc438545e5576086b973a7c924ab7aa4737b98973535b06"
};
test("the canonical Oxc fixture preserves the authoritative handoff bytes", () => {
  for (const [file, sha256] of Object.entries(fixtureHashes)) {
    expect(createHash("sha256").update(readFileSync(join(oxcFixture, file))).digest("hex")).toBe(sha256);
  }
  expect(Object.keys(fixtureHashes)).toHaveLength(4);
});

test("the Oxc command rejects a deadline-induced zero exit with exact parser output", async () => {
  const rows: Parameters<typeof command>[0] = [];
  const child = 'process.on("SIGTERM", () => { process.stderr.write("terminated-by-deadline\\n"); process.exit(0); }); process.stdout.write("ExportNamedDeclaration 0\\n"); setInterval(() => {}, 1000);';
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 4000);
  try {
    await expect(command(rows, "deadline-exit-zero", process.execPath, ["-e", child], process.env, controller.signal, 1000)).rejects.toThrow("exceeded its bound");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timedOut).toBe(true);
    expect(rows[0]?.status).toBe(0);
    expect(rows[0]?.signal).toBeNull();
    expect(rows[0]?.stdout).toBe(oxcOutputs["index.ts"]);
    expect(rows[0]?.stderr).toBe("terminated-by-deadline\n");
  } finally { clearTimeout(watchdog); }
}, 5000);

test("the Oxc command accepts a natural zero exit before its unchanged bound", async () => {
  const rows: Parameters<typeof command>[0] = [];
  const row = await command(rows, "natural-exit-zero", process.execPath, ["-e", 'process.stdout.write("ExportNamedDeclaration 0\\n");'], process.env, new AbortController().signal);
  expect(row.timedOut).toBe(false);
  expect(row.status).toBe(0);
  expect(row.signal).toBeNull();
  expect(row.stdout).toBe(oxcOutputs["index.ts"]);
});
