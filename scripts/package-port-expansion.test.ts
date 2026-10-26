import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8");
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`));

function argumentsFor(expression: string, env: Record<string, string> = {}): string[] {
  const process = { env: { ...env }, argv: ["bun", "start"], execPath: "/bin/bun", cwd: () => "/project" };
  const adapter = factory({
    native: { mainArg: () => "start", exists: (file: string) => file === "/project/package.json", readFileUtf8: () => JSON.stringify({ scripts: { start: `node entry.ts ${expression}` } }) },
    require: (name: string) => name === "process" ? process : posix,
  });
  return adapter.resolve("start").argv.slice(2);
}

const oracleDirectory = mkdtempSync(join(tmpdir(), "bun-wasm-package-port-oracle-"));
const expression = '"${PORT:-3137}" "${PORT-3137}" "$PORT" "${PORT}"';
writeFileSync(join(oracleDirectory, "package.json"), JSON.stringify({ scripts: { probe: `printf '%s\\n' ${expression}` } }));
afterAll(() => rmSync(oracleDirectory, { recursive: true, force: true }));

const values: readonly (readonly [string, Record<string, string>])[] = [["unset", {}], ["empty", { PORT: "" }], ["set", { PORT: "4141" }], ["zero", { PORT: "0" }]];
for (const [label, env] of values) test(`package defaults match the shell for ${label} variables`, () => {
  const oracle = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\n' ${expression}`], { env, stdout: "pipe", stderr: "pipe" });
  expect(oracle.exitCode).toBe(0);
  const native = Bun.spawnSync([process.execPath, "run", "probe"], { cwd: oracleDirectory, env, stdout: "pipe", stderr: "pipe" });
  expect(native.exitCode, native.stderr.toString()).toBe(0);
  expect(native.stdout.toString()).toBe(oracle.stdout.toString());
  expect(argumentsFor(expression, env)).toEqual(oracle.stdout.toString().slice(0, -1).split("\n"));
});

const quoted = [
  "'${PORT:-3137}'",
  '\\${PORT:-3137}',
  '"${PORT:-two words}"',
  '"${PORT:-$FALLBACK}"',
  '"${PORT:-"two words"}"',
  '"\\${PORT:-3137}"',
  '"${PORT:-a\\qb}"',
];
for (const expression of quoted) test(`package default quoting and escapes: ${expression}`, () => {
  const env = { FALLBACK: "4242" };
  const oracle = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\n' ${expression}`], { env, stdout: "pipe", stderr: "pipe" });
  expect(oracle.exitCode).toBe(0);
  expect(argumentsFor(expression, env)).toEqual(oracle.stdout.toString().slice(0, -1).split("\n"));
});

for (const expression of ['${PORT:+3137}', '${PORT:=3137}', '${PORT:?missing}', '${PORT%37}', '${PORT', '$(echo 3137)', '"$(echo 3137)"', '`echo 3137`', '"`echo 3137`"']) {
  test(`unsupported script expansion is rejected: ${expression}`, () => {
    expect(() => argumentsFor(expression)).toThrow();
  });
}

for (const [label, env] of values) test(`unquoted lifecycle port argument for ${label}`, () => {
  expect(argumentsFor("--host 127.0.0.1 --strictPort --port ${PORT:-3137}", env)).toEqual(["--host", "127.0.0.1", "--strictPort", "--port", env.PORT || "3137"]);
});

test("unsupported nested parameter forms are rejected rather than forwarded literally", () => {
  expect(() => argumentsFor('${PORT:-${FALLBACK:-3137}}')).toThrow("Unsupported parameter expansion");
});

for (const expression of ['${HOST:-localhost} pre${MARKER:-x}post', 'fixed ${HOST-localhost} ${MARKER:-}', '"${HOST:-\'literal\'}"', '${HOST:-$FALLBACK}']) {
  test(`default expansion is independent of variable and application: ${expression}`, () => {
    const env = { HOST: "", FALLBACK: "fallback" };
    const oracle = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\n' ${expression}`], { env, stdout: "pipe", stderr: "pipe" });
    expect(oracle.exitCode).toBe(0);
    expect(argumentsFor(expression, env)).toEqual(oracle.stdout.toString().slice(0, -1).split("\n"));
  });
}

for (const expression of ['fixed ${PORT:-""}', "fixed ${PORT:-''}", 'fixed ${PORT-""}']) {
  test(`quoted empty default keeps its argument: ${expression}`, () => {
    const oracle = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\n' ${expression}`], { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(oracle.exitCode).toBe(0);
    expect(argumentsFor(expression)).toEqual(oracle.stdout.toString().slice(0, -1).split("\n"));
  });
}
