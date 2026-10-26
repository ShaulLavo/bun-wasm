import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
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

const values: readonly (readonly [string, Record<string, string>])[] = [["unset", {}], ["empty", { PORT: "" }], ["set", { PORT: "4141" }], ["zero", { PORT: "0" }]];
for (const [label, env] of values) test(`package defaults match the shell for ${label} variables`, () => {
  const expression = '"${PORT:-3137}" "${PORT-3137}" "$PORT" "${PORT}"';
  const oracle = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\n' ${expression}`], { env, stdout: "pipe", stderr: "pipe" });
  expect(oracle.exitCode).toBe(0);
  expect(argumentsFor(expression, env)).toEqual(oracle.stdout.toString().slice(0, -1).split("\n"));
});

const quoted = [
  "'${PORT:-3137}'",
  '\\${PORT:-3137}',
  '"${PORT:-two words}"',
  '"${PORT:-$FALLBACK}"',
  '"${PORT:-\"two words\"}"',
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
