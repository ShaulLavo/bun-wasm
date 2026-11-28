import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");
function withProbe(file: string, source: string, check: () => void): void {
  const path = resolve(root, file);
  if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  try {
    writeFileSync(path, source);
    check();
  } finally {
    rmSync(path, { force: true });
  }
}
beforeAll(() => {
  const result = spawnSync("bun", ["run", "quality:duplicates"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Duplicate baseline must pass before failure probes:\n${result.stdout}${result.stderr}`);
});

function rejectsGate(gate: string, diagnostic: string, args: string[] = []): string {
  const result = spawnSync("bun", ["run", `quality:${gate}`].concat(args), { cwd: root, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  const output = result.stdout + result.stderr;
  expect(output).toContain(diagnostic);
  return output;
}

test("lint rejects an unused authored variable", () => {
  withProbe("scripts/quality-lint-probe.ts", "const unusedQualityProbe = 17;\n", () => rejectsGate("lint", "unusedQualityProbe"));
});
test("lint rejects accidental ambient browser name capture", () => {
  withProbe("web/src/quality-global-probe.ts", "export const qualityAmbientName = () => name;\n", () => rejectsGate("lint", "no-restricted-globals"));
});
test("lint rejects new nested ternaries (including moved copies and baseline growth) and else/else-if after return", () => {
  withProbe("src/quality-ternary-probe.ts", "export const pick = (a: number) => a === 1 ? 1 : a === 2 ? 2 : 3;\n", () => rejectsGate("lint", "no-nested-ternary"));
  const baselineFile = resolve(root, "src/engine-kind.ts");
  const original = readFileSync(baselineFile, "utf8");
  const grandfatheredBody = [
    "  const module: Cursor = { bytes, at: 8 };",
    "  while (module.at < bytes.length) {",
    "    const id = bytes[module.at++];",
    "    const size = readUnsigned(module);",
    "    const section: Cursor = { bytes: bytes.subarray(module.at, module.at + size), at: 0 };",
    "    module.at += size;",
    "    const limits = id === 2 ? memoryImport(section) : id === 5 && readUnsigned(section) > 0 ? readLimits(section) : undefined;",
    "    if (limits) return limits.maximum === undefined ? undefined : limits.maximum * 65536;",
    "  }",
    "  return undefined;",
  ].join("\n");
  expect(original).toContain(grandfatheredBody);
  try {
    writeFileSync(baselineFile, `${original}\nexport const qualityAddedTernary = (n: number) => n === 1 ? "a" : n === 2 ? "b" : "c";\n`);
    rejectsGate("lint", "no-nested-ternary");
    const movedBody = original.replace(grandfatheredBody, "  return qualityExtractedMemoryMax(bytes);")
      + `\nfunction qualityExtractedMemoryMax(bytes: Uint8Array): number | undefined {\n${grandfatheredBody}\n}\n`;
    writeFileSync(baselineFile, movedBody);
    rejectsGate("lint", "no-nested-ternary");
    // Adding multi-byte UTF-8 text above an unchanged baseline ternary must not invalidate it.
    writeFileSync(baselineFile, `// Café 🚀 non-ASCII comment\n${original}`);
    const unicodeResult = spawnSync("bun", ["run", "quality:lint"], { cwd: root, encoding: "utf8" });
    expect(unicodeResult.status, unicodeResult.stdout + unicodeResult.stderr).toBe(0);
  } finally {
    writeFileSync(baselineFile, original);
  }
  const baselineJsonPath = resolve(root, ".oxlint-nested-ternary-baseline.json");
  const originalBaseline = readFileSync(baselineJsonPath, "utf8");
  try {
    const mutated = JSON.parse(originalBaseline) as { reason: string; files: Record<string, string[]> };
    mutated.files["src/engine-kind.ts"] = mutated.files["src/engine-kind.ts"]!.concat(["0123456789abcdef"]);
    writeFileSync(baselineJsonPath, `${JSON.stringify(mutated, null, 2)}\n`);
    rejectsGate("lint", "nested-ternary baseline adds allowance");
  } finally {
    writeFileSync(baselineJsonPath, originalBaseline);
  }
  withProbe("src/quality-else-probe.ts", "export function sign(a: number) { if (a > 0) return 1; else if (a < 0) return -1; return 0; }\n", () => rejectsGate("lint", "no-else-return"));
});
function probeStructurePolicyTampering(): void {
  const allowPath = resolve(root, ".unknot.allow");
  const originalAllow = readFileSync(allowPath, "utf8");
  const configPath = resolve(root, ".unknot.json");
  const originalConfig = readFileSync(configPath, "utf8");
  const projectPath = resolve(root, "tsconfig.unknot.json");
  const originalProject = readFileSync(projectPath, "utf8");
  try {
    writeFileSync(allowPath, `${originalAllow}module-cycle src <-> web/src/net\n`);
    rejectsGate("structure", "structure allowlist adds entry");
    writeFileSync(allowPath, originalAllow.replace(" module-cycle", ""));
    rejectsGate("structure", "structure allowlist removes adopted rule");
    writeFileSync(allowPath, originalAllow);
    writeFileSync(configPath, `${JSON.stringify({ ...JSON.parse(originalConfig), rules: { "module-cycle": false } }, null, 2)}\n`);
    rejectsGate("structure", "structure config disables adopted rule");
    writeFileSync(configPath, `${JSON.stringify({ ...JSON.parse(originalConfig), rules: { "wide-directory": { max: 100 } } }, null, 2)}\n`);
    rejectsGate("structure", "structure config weakens rule");
    writeFileSync(configPath, `${JSON.stringify({ ...JSON.parse(originalConfig), ignore: ["web/src/net/**"] }, null, 2)}\n`);
    rejectsGate("structure", "structure config adds ignore pattern");
    withProbe("tsconfig.unknot-shadow-probe.json", '{"extends":"./tsconfig.unknot.json","compilerOptions":{"moduleSuffixes":[".missing"]}}\n', () => {
      writeFileSync(configPath, `${JSON.stringify({ ...JSON.parse(originalConfig), projects: ["tsconfig.unknot-shadow-probe.json", "tsconfig.unknot.json"] }, null, 2)}\n`);
      rejectsGate("structure", "structure config reorders or removes project");
    });
    writeFileSync(configPath, originalConfig);
    writeFileSync(projectPath, originalProject.replace('    "web/src/**/*"\n', "").replace('"src/**/*",\n', '"src/**/*"\n'));
    rejectsGate("structure", "structure project tsconfig.unknot.json removes include");
    writeFileSync(projectPath, `${JSON.stringify({ ...JSON.parse(originalProject), compilerOptions: { allowJs: false } }, null, 2)}\n`);
    rejectsGate("structure", "structure project tsconfig.unknot.json changes resolution option: allowJs");
    writeFileSync(projectPath, `${JSON.stringify({ ...JSON.parse(originalProject), compilerOptions: { moduleSuffixes: [".missing"] } }, null, 2)}\n`);
    rejectsGate("structure", "structure project tsconfig.unknot.json changes resolution option: moduleSuffixes");
    const qualityTsconfig = JSON.parse(readFileSync(resolve(root, "web/tsconfig.quality.json"), "utf8")) as { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(qualityTsconfig.compilerOptions?.paths).toBeDefined();
    writeFileSync(projectPath, `${JSON.stringify({ ...JSON.parse(originalProject), compilerOptions: { paths: qualityTsconfig.compilerOptions?.paths } }, null, 2)}\n`);
    rejectsGate("structure", "structure project tsconfig.unknot.json changes resolution option: pathsBasePath");
  } finally {
    writeFileSync(allowPath, originalAllow);
    writeFileSync(configPath, originalConfig);
    writeFileSync(projectPath, originalProject);
  }
}

test("structure and lint gates reject import cycles and allowlist growth", () => {
  withProbe("src/quality-cycle-a.ts", 'import { b } from "./quality-cycle-b"; export const a = () => b();\n', () => {
    withProbe("src/quality-cycle-b.ts", 'import { a } from "./quality-cycle-a"; export const b = () => a();\n', () => rejectsGate("structure", "import-cycle"));
  });
  withProbe("src/quality-cross-a.ts", 'import { b } from "../web/src/quality-cross-b"; export const a = () => b();\n', () => {
    withProbe("web/src/quality-cross-b.ts", 'import { a } from "../../src/quality-cross-a"; export const b = () => a();\n', () => rejectsGate("lint", "no-cycle"));
  });
  withProbe("src/quality-cross-net-a.ts", 'import { b } from "../web/src/net/quality-cross-net-b"; export const a = () => b();\n', () => {
    withProbe("web/src/net/quality-cross-net-b.ts", 'import { a } from "../../../src/quality-cross-net-a"; export const b = () => a();\n', () => {
      rejectsGate("structure", "module-cycle");
      probeStructurePolicyTampering();
    });
  });
});
test("strict scripts project rejects a wrong type", () => {
  withProbe("scripts/quality-type-probe.ts", 'export const qualityValue: number = "wrong";\n', () => rejectsGate("types", "not assignable to type 'number'"));
});
test("Knip rejects a new unreferenced source file", () => {
  withProbe("src/quality-unused-probe.ts", "export const qualityUnusedProbe = 31;\n", () => rejectsGate("unused", "src/quality-unused-probe.ts"));
}, 60_000);
test("fixed clone baseline rejects a new exact source copy", () => {
  withProbe("src/quality-clone-probe.ts", readFileSync(resolve(root, "src/bun-adapter.ts"), "utf8"), () => rejectsGate("duplicates", "new clone"));
});
test("assert/util baseline migration rejects another typed adapter copy", () => {
  withProbe("crates/bunwasm-runtime/src/js/quality_assert_clone_probe.ts", readFileSync(resolve(root, "crates/bunwasm-runtime/src/js/assert.ts"), "utf8"), () => rejectsGate("duplicates", "new clone"));
});
// Different names/literals and an extra statement avoid an exact token clone.
function rustFunction(name: string, value: string, factor: number, extra: string): string {
  return `fn ${name}(${value}: i32) -> i32 {
    let mut total = ${value} * ${factor};
    for item in 0..${value} {
      if item % ${factor} == 0 {
        total += item;
      } else {
        total -= item;
      }
      total = total.wrapping_mul(${factor});
    }
    total = total.wrapping_add(${value});
    total = total.rotate_left(${factor});
    ${extra}
    if total > ${factor} { total / ${factor} } else { total + ${factor} }
  }`;
}
test("structural Rust clones also fail the same baseline", () => {
  const source = rustFunction("quality_first", "input", 3, "") + "\n" + rustFunction("quality_second", "count", 5, "total += 1;");
  withProbe("crates/bunwasm-runtime/src/quality_clone_probe.rs", source, () => {
    expect(rejectsGate("duplicates", "new clone", ["--kind", "ast"])).toContain("quality_clone_probe.rs");
  });
});
