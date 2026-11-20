import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverChecks } from "./test-checks";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}

const root = resolve(import.meta.dir, "..");
const workflow = record(Bun.YAML.parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")));
const rawSteps = record(record(workflow.jobs)["native-quality"]).steps;
if (!Array.isArray(rawSteps)) throw new Error("Missing native quality steps");
const steps = rawSteps.map(record);

function stepNamed(name: string): Record<string, unknown> {
  const step = steps.find(step => step.name === name);
  if (!step) throw new Error(`Missing step ${name}`);
  return step;
}

const restore = stepNamed("Restore pinned Rust dependency checker");
const install = stepNamed("Install pinned Rust dependency checker");
const save = stepNamed("Save completed Rust dependency checker setup");

test("checker cache accepts only its exact pinned tool and host identity", () => {
  expect(restore.uses).toBe("actions/cache/restore@v4");
  expect(restore.id).toBe("machete-cache");
  expect(restore).not.toHaveProperty("if");
  expect(record(restore.with)).toEqual({
    path: "${{ env.CARGO_HOME }}/bin/cargo-machete",
    key: "cargo-machete-v1-0.9.2-${{ runner.os }}-${{ runner.arch }}-${{ steps.native-setup.outputs.host-tools }}-${{ steps.native-setup.outputs.native-inputs }}-${{ hashFiles('rust-toolchain.toml', '.cargo/**') }}",
  });
  expect(save.uses).toBe("actions/cache/save@v4");
  expect(record(save.with)).toEqual({
    path: record(restore.with).path,
    key: "${{ steps.machete-cache.outputs.cache-primary-key }}",
  });
});

test.each([
  ["push", "refs/heads/main", "false", true],
  ["push", "refs/heads/main", "true", false],
  ["pull_request", "refs/pull/1/merge", "false", false],
  ["pull_request_target", "refs/heads/main", "false", false],
  ["push", "refs/heads/feature", "false", false],
  ["workflow_dispatch", "refs/heads/main", "false", false],
])("checker publication for %s %s with hit %s", (event, ref, hit, allowed) => {
  if (typeof save.if !== "string") throw new Error("Missing save condition");
  const values: Record<string, unknown> = { "github.event_name": event, "github.ref": ref, "steps.machete-cache.outputs.cache-hit": hit };
  const expression = save.if.replace(/(?:github|steps)\.[\w.-]+/g, name => JSON.stringify(values[name]));
  expect(new Function(`return (${expression})`)()).toBe(allowed);
  expect(save.if).not.toMatch(/always\(|!cancelled\(/);
});

test("checker setup follows broad restores and precedes blocking native quality checks", () => {
  for (const id of ["native-setup", "native-seed"]) {
    const index = steps.findIndex(step => step.id === id);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(steps.indexOf(restore));
  }
  expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(install));
  expect(steps.indexOf(install)).toBeLessThan(steps.indexOf(save));
  expect(steps.indexOf(save)).toBeLessThan(steps.indexOf(stepNamed("Blocking native quality checks")));
  expect(install).not.toHaveProperty("if");
  expect(install).not.toHaveProperty("continue-on-error");
  expect(save).not.toHaveProperty("continue-on-error");
});

function runSetup(initial: string, installed = "0.9.2", installStatus = "0") {
  if (typeof install.run !== "string") throw new Error("Missing checker setup command");
  const scratch = mkdtempSync(resolve(tmpdir(), "bun-wasm-machete-"));
  try {
    const cargoHome = resolve(scratch, "cargo");
    mkdirSync(resolve(cargoHome, "bin"), { recursive: true });
    writeFileSync(resolve(scratch, "version"), initial);
    writeFileSync(resolve(cargoHome, "bin/cargo"), `#!/bin/bash
set -euo pipefail
case "$1" in
  machete) test -s "$MACHETE_TEST_ROOT/version"; cat "$MACHETE_TEST_ROOT/version" ;;
  install)
    printf '%s\\n' "$*" >> "$MACHETE_TEST_ROOT/installs"
    test "$MACHETE_TEST_INSTALL_STATUS" = 0
    printf '%s\\n' "$MACHETE_TEST_INSTALLED" > "$MACHETE_TEST_ROOT/version"
    ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", install.run], {
      cwd: root, encoding: "utf8", env: {
        ...process.env, CARGO_HOME: cargoHome, WASM_TOOLS: resolve(scratch, "tools"),
        MACHETE_TEST_ROOT: scratch, MACHETE_TEST_INSTALLED: installed, MACHETE_TEST_INSTALL_STATUS: installStatus,
      },
    });
    const installs = resolve(scratch, "installs");
    return { status: result.status, installs: existsSync(installs) ? readFileSync(installs, "utf8") : "" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("a correct restored or seeded checker skips installation", () => {
  expect(runSetup("0.9.2\n")).toEqual({ status: 0, installs: "" });
});

test.each(["", "0.9.1\n", "0.9.20\n"])("missing or wrong checker %j takes the one pinned fallback", version => {
  expect(runSetup(version)).toEqual({ status: 0, installs: "install cargo-machete --version 0.9.2 --locked --jobs 2\n" });
});

test("failed install and incorrect installed version fail setup", () => {
  expect(runSetup("", "0.9.2", "1").status).not.toBe(0);
  expect(runSetup("", "0.9.20").status).not.toBe(0);
});

test("checker cache controls belong to the existing source quality gate", () => {
  expect(discoverChecks(root).filter(check => check.path === "scripts/ci-machete-cache.test.ts")).toEqual([
    { owner: "quality", path: "scripts/ci-machete-cache.test.ts", localRuntime: false, batch: "default" },
  ]);
});
