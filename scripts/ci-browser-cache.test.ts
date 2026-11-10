import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneArchives } from "../web/scripts/ci-browser-deps";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const actionPath = new URL("../.github/actions/browser-deps/action.yml", import.meta.url);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected YAML object");
  return Object.fromEntries(Object.entries(value));
}

function actionSteps(): Record<string, unknown>[] {
  const action = record(Bun.YAML.parse(readFileSync(actionPath, "utf8")));
  expect(record(action.runs).using).toBe("composite");
  const steps = record(action.runs).steps;
  if (!Array.isArray(steps)) throw new Error("Expected action steps");
  return steps.map(record);
}

function fixture(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-cache-"));
  try { run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("Web host and every Processes leg use one browser dependency cache owner", () => {
  const jobs = record(record(Bun.YAML.parse(workflow)).jobs);
  for (const id of ["web", "browser-process"]) {
    const job = record(jobs[id]);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(10);
    expect(JSON.stringify(job)).not.toContain("browser-apt-v2");
    const steps = job.steps;
    if (!Array.isArray(steps)) throw new Error("Expected job steps");
    const entries = steps.map(record);
    const setup = entries.filter(step => step.uses === "./.github/actions/browser-deps");
    const installing = entries.findIndex(step => String(step.run).startsWith("bunx playwright install "));
    expect(installing).toBeGreaterThan(entries.findIndex(step => step.uses === "./.github/actions/browser-deps"));
    expect(JSON.stringify(entries)).not.toContain("playwright install --with-deps");
    expect(setup).toHaveLength(1);
    const expected = id === "web" ? "chromium firefox webkit" : "${{ matrix.browser == 'chromium' && 'chromium firefox' || matrix.browser }}";
    expect(record(setup[0]?.with).browsers).toBe(expected);
  }
});

test("cache identity is browser-set independent and refreshed for runner and Playwright updates", () => {
  const steps = actionSteps();
  const restore = steps.find(step => step.id === "browser-cache");
  expect(restore?.uses).toBe("actions/cache/restore@v4");
  const config = record(restore?.with);
  expect(config.path).toBe("${{ runner.temp }}/browser-apt/*.deb");
  expect(String(config.key)).not.toContain("inputs.browsers");
  expect(String(config.key)).toContain("hashFiles('web/scripts/ci-browser-deps.ts')");
  expect(String(config.key)).toContain("steps.browser-image.outputs.image");
  expect(String(config.key)).toContain("steps.browser-image.outputs.playwright");
  expect(config["restore-keys"]).toBeUndefined();
  const fallback = steps.find(step => record(step.with ?? {})["restore-keys"] !== undefined);
  expect(fallback?.uses).toBe("actions/cache/restore@v4");
  expect(fallback?.if).toBe("steps.browser-cache.outputs.cache-hit != 'true'");
  expect(record(fallback?.with).key).toBe("${{ steps.browser-cache.outputs.cache-primary-key }}");
  expect(record(fallback?.with).path).toBe(config.path);
  expect(record(fallback?.with)["restore-keys"]).toBe("browser-apt-v2-${{ runner.os }}-${{ runner.arch }}-\n");
  const identity = steps.find(step => step.id === "browser-image");
  const command = identity?.run;
  if (typeof command !== "string") throw new Error("Expected cache identity command");
  fixture(directory => {
    writeFileSync(join(directory, "bun.lock"), '"playwright-core@1.64.1"\n');
    const output = join(directory, "outputs");
    const invoke = (image: string) => spawnSync("bash", ["-euo", "pipefail", "-c", command], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, ImageVersion: image },
    });
    expect(invoke("20261109.1").status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("20261109.1");
    expect(readFileSync(output, "utf8")).toContain("playwright=playwright-core@1.64.1");
    writeFileSync(output, "");
    writeFileSync(join(directory, "bun.lock"), '"playwright-core@1.65.0"\n');
    expect(invoke("20261110.2").status).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("20261110.2");
    expect(readFileSync(output, "utf8")).toContain("playwright=playwright-core@1.65.0");
    expect(invoke("").status).not.toBe(0);
    writeFileSync(join(directory, "bun.lock"), '"playwright-core@1.64.1"\n"playwright-core@1.65.0"\n');
    expect(invoke("20261110.2").status).not.toBe(0);
  });
});

test("only main seeds the shared archive cache, before browser downloads or test failures", () => {
  const steps = actionSteps();
  const restore = steps.findIndex(step => step.id === "browser-cache");
  const setup = steps.findIndex(step => String(step.run).includes("ci-browser-deps.ts"));
  const save = steps.findIndex(step => step.uses === "actions/cache/save@v4");
  expect(restore).toBeGreaterThanOrEqual(0);
  expect(setup).toBeGreaterThan(restore);
  expect(save).toBeGreaterThan(setup);
  const saving = steps[save];
  const condition = saving?.if;
  if (typeof condition !== "string") throw new Error("Expected cache save condition");
  const allowed = (event: string, ref: string, hit: string) => new Function("return (" + condition
    .replaceAll("github.event_name", JSON.stringify(event)).replaceAll("github.ref", JSON.stringify(ref))
    .replaceAll("steps.browser-cache.outputs.cache-hit", JSON.stringify(hit)) + ")")();
  expect(allowed("push", "refs/heads/main", "false")).toBe(true);
  expect(allowed("push", "refs/heads/main", "true")).toBe(false);
  expect(allowed("pull_request", "refs/pull/1/merge", "false")).toBe(false);
  expect(allowed("workflow_dispatch", "refs/heads/main", "false")).toBe(false);
  expect(record(saving?.with).path).toBe(record(steps[restore]?.with).path);
  expect(record(saving?.with).key).toBe("${{ steps.browser-cache.outputs.cache-primary-key }}");
  expect(JSON.stringify(steps)).not.toContain("continue-on-error");
  expect(JSON.stringify(steps)).not.toContain("playwright install ");
});

function dependencyFixture(directory: string): void {
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "node_modules/playwright"), { recursive: true });
  copyFileSync(new URL("../web/scripts/ci-browser-deps.ts", import.meta.url), join(directory, "scripts/ci-browser-deps.ts"));
  writeFileSync(join(directory, "node_modules/playwright/cli.js"), `
    const browsers = process.argv.slice(4);
    if (process.env.INSTALLED_BROWSER && browsers.length === 1 && browsers[0] === process.env.INSTALLED_BROWSER) {
      process.stdout.write("All system dependencies are installed.\\n");
      process.exit(0);
    }
    const packages = browsers.map(browser => "lib" + browser);
    process.stdout.write("Missing system dependencies (" + packages.length + "):\\n" + packages.join("\\n") + "\\n");
  `);
  writeFileSync(join(directory, "sudo"), `#!${process.execPath}
    const args = process.argv.slice(2);
    require("node:fs").appendFileSync(process.env.APT_CALLS, JSON.stringify(args) + "\\n");
    if (args.includes("update") && process.env.FAIL_UPDATE === "1") process.exit(100);
  `, { mode: 0o755 });
}

function setupDependencies(directory: string, browsers: string[], failUpdate = false, installed = "") {
  return spawnSync(process.execPath, [join(directory, "scripts/ci-browser-deps.ts")].concat(browsers), {
    encoding: "utf8", env: { ...process.env, PATH: directory + ":" + process.env.PATH,
      GITHUB_ACTIONS: "true", RUNNER_TEMP: directory, APT_CALLS: join(directory, "apt-calls"), FAIL_UPDATE: failUpdate ? "1" : "0", INSTALLED_BROWSER: installed },
  });
}

for (const browsers of [["chromium", "firefox", "webkit"], ["chromium", "webkit"], ["chromium", "firefox"], ["firefox"], ["webkit"]]) {
  test(`${browsers.join("+")} fills the same complete archive pool but installs only its packages`, () => {
    fixture(directory => {
      dependencyFixture(directory);
      const result = setupDependencies(directory, browsers);
      expect(result.status, result.stderr).toBe(0);
      const calls: unknown[] = readFileSync(join(directory, "apt-calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual(["apt-get", "update", "--error-on=any"]);
      const plan = calls[1];
      const install = calls[2];
      if (!Array.isArray(plan) || !Array.isArray(install)) throw new Error("Expected apt argv");
      expect(plan.slice(-5, -2)).toEqual(["libchromium", "libfirefox", "libwebkit"]);
      expect(install.slice(-browsers.length)).toEqual(browsers.map(browser => "lib" + browser));
      expect(plan).toContain("Acquire::ForceHash=SHA256");
    });
  });
}

test("failed signed-index refresh stops before planning or installing any cached package", () => {
  fixture(directory => {
    dependencyFixture(directory);
    const result = setupDependencies(directory, ["webkit"], true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("apt-get update failed");
    expect(readFileSync(join(directory, "apt-calls"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});

test("refreshed archive pools discard obsolete and unrelated debs before saving", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-cache-"));
  try {
    for (const filename of ["libcurrent_2.deb", "libcurrent_1.deb", "libunrelated.deb", "lock"]) writeFileSync(join(directory, filename), filename);
    const current = { uri: "https://example.invalid/current.deb", filename: "libcurrent_2.deb", size: 1, sha256: "a".repeat(64) };
    await pruneArchives([current], directory);
    expect(readdirSync(directory).sort()).toEqual(["libcurrent_2.deb", "lock"]);
    await pruneArchives([], directory);
    expect(readdirSync(directory).sort()).toEqual(["lock"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a preinstalled browser still fills the complete pool without installing other browsers", () => {
  fixture(directory => {
    dependencyFixture(directory);
    const result = setupDependencies(directory, ["chromium"], false, "chromium");
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(join(directory, "apt-calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--print-uris");
    expect(calls[1]).toContain("libwebkit");
  });
});
