import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const entry = fileURLToPath(new URL("./producer-start.ts", import.meta.url));
const node = Bun.which("node");
if (!node) throw new Error("Producer-start fixtures require Node.js 24 or later");
const nodeExecutable: string = node;

async function withFixture(check: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-producer-start-"));
  try {
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
}

function driver(root: string): string {
  const path = join(root, "prepare.ts");
  writeFileSync(path, `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const [root, fallback, mode = "fail", id = "one"] = process.argv.slice(2);
    const report = process.env.BUN_WASM_PRODUCER_REPORT_ROOT ?? fallback;
    writeFileSync(join(root, "child-" + id), "started");
    try {
      writeFileSync(join(report, "config.json"), JSON.stringify({ id, pid: process.pid, args: process.argv.slice(6) }));
      writeFileSync(join(report, "controller.ts"), "fixture controller");
      if (mode === "fail") throw new Error("fixture setup failed after its first write");
      if (mode === "signal") process.kill(process.pid, "SIGTERM");
      if (mode === "exit") process.exitCode = 23;
    } finally {
      writeFileSync(join(root, "cleanup-" + id), "cleanup");
      writeFileSync(join(report, "marker"), "overwritten by cleanup");
    }
  `);
  return path;
}

function argv(report: string, command: string, args: string[]): string[] {
  return [entry, "--report-root", report, "--", command].concat(args);
}

function start(report: string, command: string, args: string[]) {
  return spawnSync(nodeExecutable, argv(report, command, args), { encoding: "utf8", timeout: 5000 });
}

function assertRefused(root: string, report: string, prepare: string, paths: string[]): void {
  const before = paths.map(path => lstatSync(path, { bigint: true }));
  const result = start(report, nodeExecutable, [prepare, root, report]);
  expect(existsSync(join(root, "child-one"))).toBe(false);
  expect(existsSync(join(root, "cleanup-one"))).toBe(false);
  expect(paths.map(path => lstatSync(path, { bigint: true }))).toEqual(before);
  expect(result.status).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stderr).toContain("EEXIST");
}

test("existing report is rejected before preparation and its failure cleanup", async () => {
  await withFixture(root => {
    const prepare = driver(root);
    const report = join(root, "report");
    mkdirSync(report);
    const marker = join(report, "marker");
    writeFileSync(marker, "held marker\u0000bytes");
    const beforeRoot = lstatSync(report, { bigint: true });
    const beforeMarker = lstatSync(marker, { bigint: true });
    const result = start(report, nodeExecutable, [prepare, root, report]);
    expect({
      child: existsSync(join(root, "child-one")),
      cleanup: existsSync(join(root, "cleanup-one")),
      rootUnchanged: isDeepStrictEqual(lstatSync(report, { bigint: true }), beforeRoot),
      markerUnchanged: isDeepStrictEqual(lstatSync(marker, { bigint: true }), beforeMarker),
      bytes: readFileSync(marker).toString("hex"),
      config: existsSync(join(report, "config.json")),
    }).toEqual({ child: false, cleanup: false, rootUnchanged: true, markerUnchanged: true,
      bytes: Buffer.from("held marker\u0000bytes").toString("hex"), config: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EEXIST");
  });
});

for (const kind of ["empty-directory", "file", "directory-link", "file-link", "dangling-link"]) {
  test(`refuses an existing ${kind} without changing it or its target`, async () => {
    await withFixture(root => {
      const prepare = driver(root);
      const report = join(root, "report");
      const target = join(root, "target");
      const paths = [report];
      if (kind === "empty-directory") mkdirSync(report);
      if (kind === "file") writeFileSync(report, "held file");
      if (kind === "directory-link") mkdirSync(target);
      if (kind === "file-link") writeFileSync(target, "held target\u0000bytes");
      if (kind.endsWith("link")) symlinkSync(target, report);
      if (existsSync(target)) paths.push(target);
      assertRefused(root, report, prepare, paths);
      if (kind === "file") expect(readFileSync(report, "utf8")).toBe("held file");
      if (kind === "file-link") expect(readFileSync(target)).toEqual(Buffer.from("held target\u0000bytes"));
      if (kind === "dangling-link") expect(existsSync(target)).toBe(false);
    });
  });
}

test("fresh preparation succeeds once, preserves argv and PID, and duplicate start cannot run cleanup", async () => {
  await withFixture(root => {
    const prepare = driver(root);
    const report = join(root, "fresh report");
    const result = start(report, nodeExecutable, [prepare, root, report, "success", "one", "space argument", "--literal"]);
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(report, "config.json"), "utf8"))).toEqual({ id: "one", pid: result.pid, args: ["space argument", "--literal"] });
    expect(lstatSync(report).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(report, "controller.ts"), "utf8")).toBe("fixture controller");
    const before = [report, join(report, "config.json"), join(report, "marker"), join(root, "cleanup-one")];
    const metadata = before.map(path => lstatSync(path, { bigint: true }));
    const duplicate = start(report, nodeExecutable, [prepare, root, report, "fail", "duplicate"]);
    expect(duplicate.status).toBe(1);
    expect(existsSync(join(root, "child-duplicate"))).toBe(false);
    expect(existsSync(join(root, "cleanup-duplicate"))).toBe(false);
    expect(before.map(path => lstatSync(path, { bigint: true }))).toEqual(metadata);
  });
});

for (const mode of ["fail", "exit", "signal"]) {
  test(`retains a fresh claim after ${mode} and preserves command termination`, async () => {
    await withFixture(root => {
      const prepare = driver(root);
      const report = join(root, "report");
      const result = start(report, nodeExecutable, [prepare, root, report, mode]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === "signal" ? null : mode === "exit" ? 23 : 1);
      expect(result.signal).toBe(mode === "signal" ? "SIGTERM" : null);
      expect(existsSync(report)).toBe(true);
      const duplicate = start(report, nodeExecutable, [prepare, root, report, "success", "duplicate"]);
      expect(duplicate.status).toBe(1);
      expect(existsSync(join(root, "child-duplicate"))).toBe(false);
      expect(existsSync(join(root, "cleanup-duplicate"))).toBe(false);
    });
  });
}

function contender(report: string, prepare: string, root: string, id: string): Promise<number | null> {
  const child = spawn(nodeExecutable, argv(report, nodeExecutable, [prepare, root, report, "success", id]), {
    stdio: "ignore", timeout: 5000, killSignal: "SIGKILL",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => signal ? reject(new Error(`Fixture terminated by ${signal}`)) : resolve(code));
  });
}

test("concurrent starts admit exactly one preparation and cleanup", async () => {
  await withFixture(async root => {
    const prepare = driver(root);
    const report = join(root, "report");
    const results = await Promise.allSettled([contender(report, prepare, root, "a"), contender(report, prepare, root, "b")]);
    const statuses = results.map(result => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const winner = statuses[0] === 0 ? "a" : "b";
    expect(statuses.sort()).toEqual([0, 1]);
    expect(["a", "b"].filter(id => existsSync(join(root, "child-" + id))).length).toBe(1);
    expect(["a", "b"].filter(id => existsSync(join(root, "cleanup-" + id))).length).toBe(1);
    const config: unknown = JSON.parse(readFileSync(join(report, "config.json"), "utf8"));
    expect(config).toMatchObject({ id: winner });
  });
});

test("invalid CLI and missing parent refuse before commands, and failed exec retains its claim", async () => {
  await withFixture(root => {
    const prepare = driver(root);
    const report = join(root, "report");
    for (const args of [[], ["--report-root", "relative", "--", nodeExecutable, prepare], ["--report-root", report, "--", "relative-command"]]) {
      const result = spawnSync(nodeExecutable, [entry].concat(args), { encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage:");
    }
    expect(existsSync(report)).toBe(false);
    expect(start(join(root, "absent", "report"), nodeExecutable, [prepare, root, report]).status).toBe(1);
    expect(existsSync(join(root, "absent"))).toBe(false);
    const failedExec = start(report, join(root, "absent-command"), []);
    expect(failedExec.status).toBe(1);
    expect(failedExec.signal).toBeNull();
    expect(failedExec.stderr).toContain("ENOENT");
    expect(existsSync(report)).toBe(true);
    expect(existsSync(join(root, "child-one"))).toBe(false);
    expect(existsSync(join(root, "cleanup-one"))).toBe(false);
  });
});
