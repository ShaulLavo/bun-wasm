import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCustomSection, pairedEngineKinds, programProfile } from "../src/engine-kind";
import { quickjsPair, sharedQuickjsPair } from "../tests/package/quickjs-plan-fixture";
import { command, observe, oxcFixture, oxcFixtureFiles, oxcOutputs, oxcTreeVariable, requireOxcEnvironment, requireOxcInputs, requireOxcTree } from "./real-oxc-consumer";
import { checkCode, checkMinified, checkParser, exerciseAsyncConsumer, exerciseConsumer, oxcAsyncConsumers, oxcConsumers } from "../tests/real-oxc-consumer/api";
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
    writeFileSync(program, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("group core");
  });
});

test.each(pairedEngineKinds)("a synthetic %s group requires both remaining inputs and the correct side exports", kind => {
  scratch(directory => {
    const { core, side } = sharedQuickjsPair(kind);
    const program = join(directory, "bun.wasm");
    const launcher = join(directory, "launcher");
    const browser = join(directory, "bun-browser.wasm");
    const sidePath = join(directory, programProfile(kind).side);
    writeFileSync(program, core);
    writeFileSync(sidePath, side);
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("ENOENT");
    writeFileSync(launcher, "synthetic input validator fixture, never executed");
    expect(() => requireOxcInputs(program, launcher, browser)).toThrow("ENOENT");
    writeFileSync(browser, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    expect(requireOxcInputs(program, launcher, browser)).toBe(kind);
    const mismatched = Buffer.from(side);
    mismatched[mismatched.indexOf(`${kind}_run`)] = 120;
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
  expect(oxcConsumers.map(consumer => consumer.package)).toEqual(["oxc-parser", "oxc-transform", "oxc-minify"]);
  expect(oxcOutputs["index.ts"]).toBe("parser package evaluated\nparser package API passed\ntransform package evaluated\ntransform package API passed\nminify package evaluated\nminify package API passed\n");
  expect(oxcOutputs["direct.ts"]).toBe("parser official Wasm binding evaluated\nparser official Wasm API passed\ntransform official Wasm binding evaluated\ntransform official Wasm API passed\nminify official Wasm binding evaluated\nminify official Wasm API passed\nshared memory created\n");
  expect(oxcOutputs["async.ts"]).toBe("parser package async API passed\ntransform package async API passed\n");
  expect(selectChecks("web")).toContain("scripts/fixture-tree.test.ts");
  expect(selectChecks("quality")).toContain("scripts/real-oxc-consumer.test.ts");
});

test("the canonical Oxc fixture pins all public families and freezes every entry and helper", () => {
  const manifest = JSON.parse(readFileSync(join(oxcFixture, "package.json"), "utf8"));
  expect(manifest.dependencies).toEqual({ "oxc-parser": "0.94.0", "oxc-transform": "0.94.0", "oxc-minify": "0.94.0" });
  expect(oxcFixtureFiles).toEqual(["package.json", "bun.lock", "api.ts", "index.ts", "direct.ts", "async.ts"]);
  const lock = Bun.JSONC.parse(readFileSync(join(oxcFixture, "bun.lock"), "utf8"));
  expect(lock.workspaces[""].dependencies).toEqual(manifest.dependencies);
  for (const name of oxcConsumers.flatMap(consumer => [consumer.package, consumer.binding])) {
    expect(lock.packages[name][0]).toBe(`${name}@0.94.0`);
  }
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
    expect(rows[0]?.stdout).toBe("ExportNamedDeclaration 0\n");
    expect(rows[0]?.stderr).toBe("terminated-by-deadline\n");
  } finally { clearTimeout(watchdog); }
}, 5000);

test("the Oxc command accepts a natural zero exit before its unchanged bound", async () => {
  const rows: Parameters<typeof command>[0] = [];
  const row = await command(rows, "natural-exit-zero", process.execPath, ["-e", 'process.stdout.write("ExportNamedDeclaration 0\\n");'], process.env, new AbortController().signal);
  expect(row.timedOut).toBe(false);
  expect(row.status).toBe(0);
  expect(row.signal).toBeNull();
  expect(row.stdout).toBe("ExportNamedDeclaration 0\n");
});

test("the installed-tree check requires every official package and binding layout", () => {
  scratch(directory => {
    cpSync(oxcFixture, directory, { recursive: true });
    for (const name of oxcConsumers.flatMap(consumer => [consumer.package, consumer.binding])) {
      const packageRoot = join(directory, "node_modules", name);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, version: "0.94.0" }));
    }
    for (const consumer of oxcConsumers) {
      const binding = join(directory, "node_modules", consumer.binding, consumer.name);
      writeFileSync(`${binding}.wasm32-wasi.wasm`, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      writeFileSync(`${binding}.wasi.cjs`, "module.exports = {};\n");
    }
    expect(() => requireOxcTree(directory)).not.toThrow();
    rmSync(join(directory, "node_modules/@oxc-minify/binding-wasm32-wasi/minify.wasm32-wasi.wasm"));
    expect(() => requireOxcTree(directory)).toThrow("ENOENT");
  });
});

test("report-only API controls reject unchanged, erroneous and wrong-result output", () => {
  expect(() => checkCode({ errors: [], code: "globalThis.__oxcAnswer = 42;" })).not.toThrow();
  for (const result of [{ errors: ["syntax error"], code: "globalThis.__oxcAnswer = 42;" }, { errors: [], code: "" }, { errors: [], code: "globalThis.__oxcAnswer = 41;" }]) {
    expect(() => checkCode(result)).toThrow();
  }
  for (const consumer of oxcConsumers) expect(() => exerciseConsumer(consumer, {})).toThrow(`Missing ${consumer.method}`);
  const minifier = oxcConsumers[2];
  expect(() => checkMinified({ errors: [], code: minifier.source })).toThrow("Minification must shorten");
  expect(() => checkMinified({ errors: [], code: "globalThis.__oxcAnswer=42;" })).not.toThrow();
});

test("report-only parser controls check both wrapped public and raw binding results", () => {
  const program = { type: "Program", body: [{ type: "ExportNamedDeclaration", declaration: { declarations: [{ id: { name: "answer" }, init: { value: 42 } }] } }] };
  expect(() => checkParser({ errors: [], program })).not.toThrow();
  expect(() => checkParser({ errors: [], program: JSON.stringify({ node: program, fixes: [] }) })).not.toThrow();
  expect(() => checkParser({ errors: [], program: { type: "Program", body: [] } })).toThrow();
  expect(() => checkParser({ errors: ["parse error"], program })).toThrow();
});

test("a public selection failure cannot suppress direct binding observations", async () => {
  const failures: unknown[] = [];
  const observed: string[] = [];
  await observe(failures, async () => { throw new Error("stock loader hid binding error"); });
  await observe(failures, async () => { observed.push("direct binding attempted"); });
  expect(failures).toHaveLength(1);
  expect(observed).toEqual(["direct binding attempted"]);
});

test.each(oxcAsyncConsumers)("report-only $package async controls require a promise and usable output", async consumer => {
  await expect(exerciseAsyncConsumer(consumer, {})).rejects.toThrow(`Missing ${consumer.asyncMethod}`);
  await expect(exerciseAsyncConsumer(consumer, { [consumer.asyncMethod]: () => ({ errors: [] }) })).rejects.toThrow("must return a promise");
  await expect(exerciseAsyncConsumer(consumer, { [consumer.asyncMethod]: () => Promise.resolve({ errors: ["async parse failed"] }) })).rejects.toThrow("Oxc reported errors");
});

test("report-only transform controls pass filename and TypeScript options before checking generated code", () => {
  const consumer = oxcConsumers[1];
  const calls: unknown[][] = [];
  exerciseConsumer(consumer, { transform(...args: unknown[]) {
    calls.push(args);
    return { errors: [], code: "globalThis.__oxcAnswer=42;" };
  } });
  expect(calls).toEqual([["input.ts", consumer.source, { cwd: "/", lang: "ts" }]]);
});
