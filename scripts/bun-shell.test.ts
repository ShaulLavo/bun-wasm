import { expect, test } from "bun:test";
import { $ as native } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

// The runtime module over host bash, compared with native Bun.$ on the same inputs.
const source = fs.readFileSync(new URL("../crates/bunwasm-runtime/src/js/bun_shell.ts", import.meta.url), "utf8");
const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync("globalThis.factory = " + source), {
  Blob, Response, ReadableStream, ArrayBuffer, TextEncoder, TextDecoder, Promise, Symbol, Error, TypeError, Object, Array, JSON, Date,
});
class BunFile { constructor(readonly name: string) {} }
const spawned: string[][] = [];
const guest = {
  process,
  path,
  buffer: { Buffer },
  fs,
  spawn: {
    which: (name: string, options: { PATH?: string; cwd?: string }) => Bun.which(name, options),
    spawn(argv: string[], options: { cwd: string; env: Record<string, string | undefined>; stdin: "inherit" }) {
      spawned.push(argv);
      return Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    },
  },
};
const { $ } = factory({ require: (name: keyof typeof guest) => guest[name], builtin: (name: string) => name === "node:fs" ? fs : undefined, BunFile });

const strings = ["plain", "", "a b", "it's", "say \"hi\"", "$HOME", "`cmd`", "back\\slash", "semi;colon", "glob*", "tab\there", "ünïcode", "123"];

test("escape matches Bun.$.escape", () => {
  for (const value of strings) expect($.escape(value)).toBe(native.escape(value));
});

test("braces match Bun.$.braces", () => {
  for (const pattern of ["{a,b}{1..2}", "x{a,{b,c}}y", "{a}", "pre{,x}", "{a,b}-{c,d}", "no braces", "a{b,c"])
    expect($.braces(pattern)).toEqual(native.braces(pattern));
});

type Shell = typeof native;
const cases: Record<string, (shell: Shell) => Promise<unknown>> = {
  interpolated: shell => Promise.all(strings.map(value => shell`printf '[%s]' ${value}`.text())),
  array: shell => shell`printf '[%s]' ${["a b", "c", ""]}`.text(),
  json: shell => shell`echo ${JSON.stringify({ a: [1, "two"] })}`.json(),
  lines: async shell => { const lines = []; for await (const line of shell`printf '%s\n' one two`.lines()) lines.push(line); return lines; },
  nothrow: async shell => (await shell`exit 3`.nothrow().quiet()).exitCode,
  thrown: shell => shell`echo out; echo boom 1>&2; exit 4`.quiet().then(() => "none", (error: InstanceType<Shell["ShellError"]>) =>
    ({ name: error.name, message: error.message, exitCode: error.exitCode, stdout: error.stdout.toString(), stderr: error.stderr.toString(), info: (error as unknown as { info: { exitCode: number } }).info.exitCode })),
  throwsFalse: async shell => (await shell`exit 5`.throws(false).quiet()).exitCode,
  cwd: async shell => (await shell`pwd`.cwd("/tmp").text()).trim(),
  env: async shell => (await shell`echo $BUN_SHELL_VALUE`.env({ ...process.env, BUN_SHELL_VALUE: "from-env" }).text()).trim(),
  pipe: shell => shell`printf 'x\ny\nx\n' | grep x`.text(),
  andOr: shell => shell`false || echo or-branch && echo and-branch`.text(),
  redirectIn: shell => shell`cat < ${new Response("from js\n")}`.text(),
  redirectBlob: shell => shell`cat < ${new Blob(["blob bytes"])}`.text(),
  raw: shell => shell`echo ${{ raw: "'raw   quoted'  word" }}`.text(),
  bytes: async shell => Array.from(new Uint8Array(await shell`printf 'ab'`.arrayBuffer())),
  blob: async shell => (await shell`printf 'blob'`.blob()).text(),
  output: async shell => { const out = await shell`printf 'o'; printf 'e' 1>&2`.quiet(); return [out.exitCode, out.stdout.toString(), out.stderr.toString(), out.text()]; },
  redirectOut: async shell => { const buffer = Buffer.alloc(5); await shell`printf hello > ${buffer}`.quiet(); return buffer.toString(); },
  globalNothrow: async shell => { const local = new shell.Shell(); local.nothrow(); return (await local`exit 6`.quiet()).exitCode; },
  globalCwd: async shell => { const local = new shell.Shell(); local.cwd("/"); return (await local`pwd`.text()).trim(); },
};

test("commands match Bun.$ through the system shell", async () => {
  for (const [name, run] of Object.entries(cases)) expect([name, await run($)]).toEqual([name, await run(native)]);
  expect(spawned.every(argv => argv.length === 3 && argv[1] === "-c" && /\/(ba)?sh$/.test(argv[0] ?? ""))).toBe(true);
});

test("promises run lazily and only once", async () => {
  const before = spawned.length;
  const pending = $`printf once`;
  expect(spawned.length).toBe(before);
  expect(await pending.text()).toBe("once");
  await pending;
  expect(spawned.length).toBe(before + 1);
  expect(() => pending.cwd("/")).toThrow("Shell is already running");
});

test("binary objects outside redirects are rejected, as a template misuse", () => {
  expect(() => $`cat ${new Blob(["x"])}`).toThrow(TypeError);
  expect(() => ($ as unknown as (value: string) => unknown)("echo")).toThrow("tagged template");
});
