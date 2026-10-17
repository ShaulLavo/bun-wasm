import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync("globalThis.factory = " + readFileSync(new URL("../../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8")));
function fixture(check: (cwd: string) => void) {
  const cwd = mkdtempSync("/work/tmp/bun-wasm-script-resolution-");
  try { check(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
function write(cwd: string, name: string, text: string) {
  const file = join(cwd, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}
function dispatched(cwd: string, name: string, env: Record<string, string> = {}) {
  const process = { cwd: () => cwd, argv: ["bun", name], execPath: "bun", env };
  return factory({
    native: {
      mainArg: () => name, setMainPath() {}, exists: existsSync, readFileUtf8: (file: string) => readFileSync(file, "utf8"),
      stat: (file: string, lstat: boolean) => lstat ? lstatSync(file) : statSync(file), readlink: readlinkSync,
      readdir: (file: string) => readdirSync(file, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file"]),
      resolve(file: string) {
        const found = [file, file + ".ts", file + ".js"].find(existsSync);
        if (!found) throw new Error("Module not found");
        return found;
      },
    },
    require: (name: string) => name === "path" ? path : process,
  }).resolve(resolve(cwd, name));
}
function native(cwd: string, name: string) {
  const result = Bun.spawnSync([process.execPath, "run", name], { cwd, env: { ...process.env, BUN_INSTALL_AUTO: "0" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return { stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
}

for (const linked of [true, false]) test(`script command kinds preserve native precedence, linked=${linked}`, () => fixture(cwd => {
  write(cwd, "package.json", JSON.stringify({ scripts: { bare: "tool", explicit: "./tool", runtime: "bun tool", node: "node tool" } }));
  write(cwd, "tool", '#!/usr/bin/env bun\nconsole.log("source-file");');
  write(cwd, "node_modules/pkg/package.json", '{"name":"pkg","bin":{"tool":"cli.ts"}}');
  write(cwd, "node_modules/pkg/cli.ts", '#!/usr/bin/env bun\nconsole.log("package-bin");');
  mkdirSync(join(cwd, "node_modules/.bin"));
  symlinkSync("../pkg/cli.ts", join(cwd, "node_modules/.bin/tool"));
  expect(native(cwd, "bare").stdout).toBe("package-bin");
  expect(native(cwd, "explicit").stdout).toBe("source-file");
  expect(native(cwd, "runtime").stdout).toBe("source-file");
  if (!linked) rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
  expect(dispatched(cwd, "bare")).toBe(join(cwd, "node_modules/pkg/cli.ts"));
  for (const name of ["explicit", "runtime", "node", "tool"]) expect(dispatched(cwd, name)).toBe(join(cwd, "tool"));
}));

for (const target of [42, "", "../outside.ts", "/outside.ts"]) test(`invalid bin target ${JSON.stringify(target)} cannot mask a valid package`, () => fixture(cwd => {
  write(cwd, "package.json", '{"scripts":{"start":"cmd"}}');
  write(cwd, "node_modules/a-good/package.json", '{"name":"a-good","bin":{"cmd":"cli.ts"}}');
  write(cwd, "node_modules/a-good/cli.ts", '#!/usr/bin/env bun\nconsole.log("valid-bin");');
  write(cwd, "node_modules/z-bad/package.json", JSON.stringify({ name: "z-bad", bin: { cmd: target } }));
  mkdirSync(join(cwd, "node_modules/.bin"));
  symlinkSync("../a-good/cli.ts", join(cwd, "node_modules/.bin/cmd"));
  const result = native(cwd, "start");
  expect(result.stdout).toBe("valid-bin");
  expect(result.stderr).not.toMatch(/warn|invalid|malformed/i);
  rmSync(join(cwd, "node_modules/.bin"), { recursive: true });
  expect(dispatched(cwd, "cmd")).toBe(join(cwd, "node_modules/a-good/cli.ts"));
  expect(dispatched(cwd, "start")).toBe(join(cwd, "node_modules/a-good/cli.ts"));
}));

test("bare script commands use PATH and never infer a cwd source file", () => fixture(cwd => {
  write(cwd, "package.json", '{"scripts":{"start":"tool"}}');
  write(cwd, "tool.ts", 'throw new Error("cwd source must not run");');
  write(cwd, "tools/tool", '#!/usr/bin/env bun\nconsole.log("path-bin");');
  expect(dispatched(cwd, "start", { PATH: join(cwd, "tools") })).toBe(join(cwd, "tools/tool"));
  expect(() => dispatched(cwd, "start")).toThrow(/not found/i);
}));
