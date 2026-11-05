import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Claimed, ClaimRefused, RootError, validateBrowserTmp, validatePlan, type RootPlan, type RootSpec } from "./roots.ts";

const roots = join(import.meta.dir, "roots.ts");
async function withFixture(check: (root: string) => void | Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bun-wasm-c1-claim-")));
  try { await check(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function plan(root: string): RootPlan {
  return { operation: "run", admission: [{ name: "private", path: join(root, "private"), retained: false }],
    durable: [{ name: "report", path: join(root, "report"), retained: true }, { name: "artifact", path: join(root, "artifact"), retained: true }] };
}
function metadata(paths: readonly string[]) { return paths.map(path => lstatSync(path, { bigint: true })); }
/** A separate controller process: validates, claims, then "prepares" by writing into the report. */
function starter(root: string, mode: "success" | "fail" | "exit" | "signal", id: string): string[] {
  const script = `import { Claimed, validatePlan } from ${JSON.stringify(roots)};
import { writeFileSync } from "node:fs";
const plan = ${JSON.stringify(plan(root))};
validatePlan(plan, []);
const claimed = new Claimed();
claimed.claim(plan.admission);
claimed.claim(plan.durable);
writeFileSync(${JSON.stringify(join(root, "prepared-"))} + ${JSON.stringify(id)}, "prepared");
writeFileSync(${JSON.stringify(join(root, "report/config.json"))}, ${JSON.stringify(id)});
if (${JSON.stringify(mode)} === "fail") throw new Error("setup failed after its first write");
if (${JSON.stringify(mode)} === "signal") process.kill(process.pid, "SIGTERM");
if (${JSON.stringify(mode)} === "exit") process.exitCode = 23;
claimed.removeScratch();`;
  return [process.execPath, "-e", script];
}
function start(root: string, mode: "success" | "fail" | "exit" | "signal", id = "one") {
  const [file, ...args] = starter(root, mode, id);
  return spawnSync(file ?? "", args, { encoding: "utf8", timeout: 10000 });
}

for (const kind of ["empty-directory", "held-directory", "file", "directory-link", "file-link", "dangling-link"]) {
  test(`an existing ${kind} report refuses before preparation and keeps its metadata`, () => withFixture(root => {
    const report = join(root, "report");
    const target = join(root, "target");
    if (kind.endsWith("directory")) mkdirSync(report);
    if (kind === "held-directory") writeFileSync(join(report, "marker"), "held marker\u0000bytes");
    if (kind === "file") writeFileSync(report, "held file");
    if (kind === "directory-link") mkdirSync(target);
    if (kind === "file-link") writeFileSync(target, "held target");
    if (kind.endsWith("link")) symlinkSync(target, report);
    const watched = [report].concat(existsSync(target) ? [target] : [], kind === "held-directory" ? [join(report, "marker")] : []);
    const before = metadata(watched);
    const result = start(root, "fail");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("report root already exists");
    expect(metadata(watched)).toEqual(before);
    expect(existsSync(join(root, "prepared-one"))).toBe(false);
    expect(existsSync(join(root, "private"))).toBe(false);
    if (kind === "held-directory") expect(readFileSync(join(report, "marker"), "utf8")).toBe("held marker\u0000bytes");
    if (kind === "dangling-link") expect(existsSync(target)).toBe(false);
  }));
}

test("a fresh claim is mode 0700 and a duplicate start neither prepares nor cleans", () => withFixture(root => {
  expect(start(root, "success").status).toBe(0);
  const report = join(root, "report");
  expect(lstatSync(report).mode & 0o777).toBe(0o700);
  expect(existsSync(join(root, "private"))).toBe(false);
  const watched = [report, join(report, "config.json"), join(root, "artifact")];
  const before = metadata(watched);
  const duplicate = start(root, "fail", "duplicate");
  expect(duplicate.status).toBe(1);
  expect(existsSync(join(root, "prepared-duplicate"))).toBe(false);
  expect(metadata(watched)).toEqual(before);
}));

for (const mode of ["fail", "exit", "signal"] as const) {
  test(`a claim is retained after ${mode} and blocks a second start`, () => withFixture(root => {
    const result = start(root, mode);
    expect(result.status).toBe(mode === "signal" ? null : mode === "exit" ? 23 : 1);
    expect(result.signal).toBe(mode === "signal" ? "SIGTERM" : null);
    expect(readFileSync(join(root, "report/config.json"), "utf8")).toBe("one");
    expect(start(root, "success", "second").status).toBe(1);
    expect(existsSync(join(root, "prepared-second"))).toBe(false);
  }));
}

function contender(root: string, id: string): Promise<number | null> {
  const [file, ...args] = starter(root, "success", id);
  const child = spawn(file ?? "", args, { stdio: "ignore", timeout: 10000, killSignal: "SIGKILL" });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => signal ? reject(new Error(`contender terminated by ${signal}`)) : resolve(code));
  });
}
test("concurrent starts admit exactly one preparation", () => withFixture(async root => {
  const statuses = await Promise.all([contender(root, "a"), contender(root, "b")]);
  expect(statuses.toSorted()).toEqual([0, 1]);
  expect(["a", "b"].filter(id => existsSync(join(root, `prepared-${id}`)))).toHaveLength(1);
  expect(readFileSync(join(root, "report/config.json"), "utf8")).toBe(statuses[0] === 0 ? "a" : "b");
}));

test("a later durable root refused after the report keeps the report and never cleans the other root", () => withFixture(root => {
  const roots = plan(root);
  validatePlan(roots, []);
  const artifact = join(root, "artifact");
  mkdirSync(artifact);
  writeFileSync(join(artifact, "held"), "held");
  const before = metadata([artifact, join(artifact, "held")]);
  const claimed = new Claimed();
  claimed.claim(roots.admission);
  let refusal: unknown;
  try { claimed.claim(roots.durable); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(ClaimRefused);
  expect((refusal as ClaimRefused).created.map((spec: RootSpec) => spec.name)).toEqual(["private", "report"]);
  claimed.removeScratch();
  expect(existsSync(join(root, "report"))).toBe(true);
  expect(existsSync(join(root, "private"))).toBe(false);
  expect(metadata([artifact, join(artifact, "held")])).toEqual(before);
}));

test("absent or symlinked parents and overlapping roots refuse before any write", () => withFixture(root => {
  const refuse = (value: RootPlan, inputs: readonly string[], message: string) => {
    expect(() => validatePlan(value, inputs)).toThrow(message);
    expect(existsSync(join(root, "private"))).toBe(false);
  };
  const base = plan(root);
  refuse({ ...base, durable: [{ name: "report", path: join(root, "absent/report"), retained: true }] }, [], "parent is missing");
  mkdirSync(join(root, "real/sub"), { recursive: true });
  symlinkSync(join(root, "real"), join(root, "alias"));
  refuse({ ...base, durable: [{ name: "report", path: join(root, "alias/report"), retained: true }] }, [], "not a directory");
  refuse({ ...base, durable: [{ name: "report", path: join(root, "alias/sub/report"), retained: true }] }, [], "not a physical path");
  refuse({ ...base, durable: [{ name: "report", path: join(root, "report"), retained: true }, { name: "output", path: join(root, "report"), retained: true }] }, [], "overlap");
  const source = join(root, "source");
  mkdirSync(source);
  refuse({ ...base, durable: [{ name: "output", path: join(source, "q"), retained: true }] }, [source], "overlaps protected input");
  refuse(base, [join(root, "report/inside-input.json")], "overlaps protected input");
  const retained = join(root, "real/delivery");
  mkdirSync(retained);
  refuse({ ...base, admission: [{ name: "private", path: join(retained, "copy"), retained: false }] }, [join(root, "alias/delivery")], "overlaps protected input");
}));

test("the browser scratch root leaves room for the longest Chromium runner suffix", () => {
  expect(() => validateBrowserTmp("/work/tmp/c6")).not.toThrow();
  expect(() => validateBrowserTmp("/work/tmp/c61")).toThrow(RootError);
  expect(() => validateBrowserTmp("/work/tmp/é6")).toThrow("49 bytes");
});
