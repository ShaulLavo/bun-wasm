import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
test("strict scripts project rejects a wrong type", () => {
  withProbe("scripts/quality-type-probe.ts", 'export const qualityValue: number = "wrong";\n', () => rejectsGate("types", "not assignable to type 'number'"));
});
test("Knip rejects a new unreferenced source file", () => {
  withProbe("src/quality-unused-probe.ts", "export const qualityUnusedProbe = 31;\n", () => rejectsGate("unused", "src/quality-unused-probe.ts"));
});
test("fixed clone baseline rejects a new exact source copy", () => {
  withProbe("src/quality-clone-probe.ts", readFileSync(resolve(root, "src/bun-adapter.ts"), "utf8"), () => rejectsGate("duplicates", "new clone"));
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

test("Knip allows the guest Next diagnostic but rejects a host Next import", () => {
  const clean = spawnSync("bun", ["run", "quality:unused"], { cwd: root, encoding: "utf8" });
  expect(clean.status, clean.stdout + clean.stderr).toBe(0);
  withProbe("web/tests/browser-quality-next-probe.ts", 'import "next";\n', () => {
    const output = rejectsGate("unused", "next");
    expect(output).toContain("web/tests/browser-quality-next-probe.ts");
  });
});
