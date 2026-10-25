import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeJsCommands } from "./runtime-js-process";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-runtime-js-controls-"));
const commands = new RuntimeJsCommands(() => rmSync(scratch, { recursive: true, force: true }));
const script = join(import.meta.dir, "transpile-runtime.ts");
const fixture = join(import.meta.dir, "fixtures/runtime-js-child.ts");
afterEach(() => commands.cancel());
afterAll(async () => {
  await commands.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

function run(command: string, args: string[]) {
  return commands.run(command, args, { phase: "transform-control", timeout: 4000 });
}

function pair(stem: string, text: string) {
  const source = join(scratch, `${stem}.ts`), destination = join(scratch, `${stem}.js`);
  writeFileSync(source, text);
  return [source, destination];
}

function assertGone(directory: string): void {
  for (const file of readdirSync(directory)) {
    const pid = Number(readFileSync(join(directory, file), "utf8"));
    expect(() => process.kill(pid, 0), `owned PID ${pid} from ${file}`).toThrow();
  }
}

test("ordinary and compact batches preserve single-file bytes and strict factory behavior", async () => {
  const input = '(function (this: unknown, value: number): number { "use strict";\n type Gone = number;\n const text = `keep\n   \nspacing`;\n if (this !== undefined) throw new Error(text);\n return value + 1;\n})\n';
  for (const runtime of ["node", "bun"]) {
    const options = runtime === "bun" ? ["--minify-whitespace"] : [];
    const first = pair(`${runtime}-first`, input), second = pair(`${runtime}-second`, input.replace("value + 1", "value + 2"));
    const result = await run(runtime, [script, "--batch"].concat(first, second, options));
    expect(result.exitCode, result.diagnostic).toBe(0);
    const single = join(scratch, `${runtime}-single.js`);
    expect((await run(runtime, [script, first[0]!, single].concat(options))).exitCode).toBe(0);
    const emitted = readFileSync(first[1]!, "utf8");
    expect(emitted).toBe(readFileSync(single, "utf8"));
    // oxlint-disable-next-line no-eval -- Exercise strict classic-script factory semantics.
    expect((0, eval)(emitted)(41)).toBe(42);
    // oxlint-disable-next-line no-eval -- Ensure the second batch entry is not a copy of the first.
    expect((0, eval)(readFileSync(second[1]!, "utf8"))(40)).toBe(42);
    if (runtime === "node") expect(emitted.split("\n")).toHaveLength(input.split("\n").length);
  }
});

test("a batch reports its failing phase and filename and stops before later outputs", async () => {
  const invalid = pair("invalid", "(function (value: ) {})\n");
  const later = pair("never-written", "(function () {})\n");
  const result = await run("node", [script, "--batch"].concat(invalid, later));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(`phase=strip source=${invalid[0]}`);
  expect(() => readFileSync(later[1]!)).toThrow();
});

for (const mode of ["success", "failure", "deadline", "cancel"] as const) {
  test(`owned ${mode} command reaps its leader and removes inherited descendants`, async () => {
    const directory = join(scratch, mode);
    mkdirSync(directory);
    const controller = new AbortController();
    const result = await commands.run("node", [fixture, directory, mode], {
      phase: "lifecycle-control", timeout: 1000, signal: controller.signal,
      onStderr: text => { if (mode === "cancel" && text.includes("phase=fixture")) controller.abort(); },
    });
    expect(result.reason, result.diagnostic).toBe(mode === "deadline" ? "deadline" : mode === "cancel" ? "cancel" : "exit");
    expect(result.exitCode, result.diagnostic).toBe(mode === "success" ? 0 : mode === "failure" ? 7 : null);
    if (mode === "deadline" || mode === "cancel") expect(result.signal).toBe("SIGKILL");
    expect(result.diagnostic).toContain("phase=lifecycle-control");
    expect(result.stderr).toContain("runtime-js phase=fixture source=");
    expect(readdirSync(directory).sort()).toEqual([`${mode}.pid`, "descendant.pid"].sort());
    assertGone(directory);
  });
}

test("spawn failure and pre-launch cancellation leave no owned command", async () => {
  const failed = await run(join(scratch, "missing-executable"), []);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.diagnostic).toContain("ENOENT");
  const controller = new AbortController();
  controller.abort();
  await expect(commands.run("node", [fixture], { phase: "aborted", timeout: 1000, signal: controller.signal })).rejects.toThrow();
  await commands.cancel();
});
