import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// The colour decision and `<tag>` markup in crates/bunwasm-runtime/src/js/pretty_output.ts,
// evaluated once per environment because the module decides once per process.
const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/pretty_output.ts", import.meta.url), "utf8");
const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`return (${source.replace(/;\s*$/, "")})`);

type PrettyOutput = { stdout: boolean; stderr: boolean; prettyFmt(template: string, enabled: boolean): string };

function load(env: Record<string, string>, tty: { stdout: boolean; stderr: boolean }): PrettyOutput {
  const context = createContext({ process: { env } });
  const factory = runInContext(`(function () {${transpiled}\n})()`, context) as (internal: object) => PrettyOutput;
  return factory({ native: { isatty: (fd: number) => (fd === 1 ? tty.stdout : fd === 2 ? tty.stderr : false) } });
}

const piped = { stdout: false, stderr: false };

// Native Bun 1.4.5 with both streams piped prints Bun.enableANSIColors as shown.
test("FORCE_COLOR follows native Bun's unsigned parse", () => {
  const cases: [string, boolean][] = [
    ["0", false], ["-0", false], ["+0", false], ["0_0", false], ["00", false],
    ["1", true], ["2", true], ["1_0", true], ["", true], [" ", true], [" 1", true], ["1 ", true],
    ["0x1", true], ["1.5", true], ["-1", true], ["abc", true], ["false", false], ["no", false], ["off", false],
    ["_0", true], ["0_", true], ["18446744073709551613", true], ["18446744073709551614", true], ["99999999999999999999999", true],
  ];
  for (const [value, colored] of cases) {
    const output = load({ FORCE_COLOR: value }, piped);
    expect({ value, stdout: output.stdout, stderr: output.stderr }).toEqual({ value, stdout: colored, stderr: colored });
  }
});

test("NO_COLOR turns colours off unless FORCE_COLOR forces them, and each stream follows its own terminal", () => {
  const terminal = { stdout: true, stderr: true };
  expect(load({}, { stdout: true, stderr: false })).toMatchObject({ stdout: true, stderr: false });
  expect(load({}, { stdout: false, stderr: true })).toMatchObject({ stdout: false, stderr: true });
  expect(load({ NO_COLOR: "1" }, terminal)).toMatchObject({ stdout: false, stderr: false });
  expect(load({ NO_COLOR: "0" }, terminal)).toMatchObject({ stdout: true, stderr: true });
  expect(load({ NO_COLOR: "1", FORCE_COLOR: "1" }, piped)).toMatchObject({ stdout: true, stderr: true });
  expect(load({ FORCE_COLOR: "0" }, terminal)).toMatchObject({ stdout: true, stderr: true });
});

test("markup becomes escapes with colours and disappears without", () => {
  const output = load({}, piped);
  expect(output.prettyFmt("<r><green>✓<r> \\<b\\> <d>x</d>", true)).toBe("\u001b[0m\u001b[32m✓\u001b[0m <b> \u001b[2mx\u001b[0m");
  expect(output.prettyFmt("<r><green>✓<r> \\<b\\> <d>x</d>", false)).toBe("✓ <b> x");
});
