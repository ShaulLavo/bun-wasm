import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";

// The runtime module with a recording spawn: what bun run hands the system shell.
const load = (name: string) => runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync("globalThis.factory = " + readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url), "utf8")), { Blob, Response, ReadableStream, ArrayBuffer });
const { escape } = load("bun_shell")({ require: () => ({}), builtin: () => ({}), BunFile: class {} });
const factory = load("package_scripts");

type Exit = { code: number; signal?: string };
function project(scripts: Record<string, string>, check: (cwd: string) => Promise<void> | void) {
  const root = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const cwd = mkdtempSync(path.join(root, "bun-wasm-package-scripts-"));
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts }));
  return Promise.resolve(check(cwd)).finally(() => rmSync(cwd, { recursive: true, force: true }));
}
function runtime(cwd: string, name: string, args: string[] = [], options: { exits?: Record<string, Exit>; execArgv?: string[] } = {}) {
  const spawned: { argv: string[]; event: string | undefined; script: string | undefined }[] = [];
  let stderr = "";
  const env: Record<string, string | undefined> = { PATH: "/bin" };
  const guest = {
    cwd: () => cwd, argv: ["bun", name].concat(args), execPath: "/bin/bun", execArgv: options.execArgv ?? [], env, exitCode: undefined as number | undefined,
    stderr: { isTTY: false, write: (chunk: string) => { stderr += chunk; } },
  };
  const scripts = factory({
    native: {
      mainArg: () => name, setMainPath() {}, exists: existsSync, readFileUtf8: (file: string) => readFileSync(file, "utf8"),
      stat: (file: string, lstat: boolean) => lstat ? lstatSync(file) : statSync(file), readlink: readlinkSync,
      readdir: (file: string) => readdirSync(file, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file"]),
      resolve(file: string) {
        const found = [file, file + ".ts", file + ".js"].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
        if (!found) throw new Error("Module not found");
        return found;
      },
    },
    require(module: string) {
      if (module === "path") return path;
      if (module === "process") return guest;
      if (module === "bun_shell") return { findShell: () => "/bin/bash", escape };
      if (module === "spawn") return {
        spawn(argv: string[], spawnOptions: { env: Record<string, string> }) {
          spawned.push({ argv, event: spawnOptions.env.npm_lifecycle_event, script: spawnOptions.env.npm_lifecycle_script });
          const exit = options.exits?.[spawnOptions.env.npm_lifecycle_event] ?? { code: 0 };
          return { exited: Promise.resolve(exit.code), signalCode: exit.signal ?? null };
        },
      };
      throw new Error(`Unexpected module ${module}`);
    },
  });
  return { scripts, spawned, guest, stderr: () => stderr };
}

test("a package script runs in the system shell with pre and post hooks and escaped arguments", () => project({ prebuild: "echo pre", build: "vite build", postbuild: "echo post" }, async cwd => {
  const { scripts, spawned, guest, stderr } = runtime(cwd, "build", ["--mode", "a b", "$HOME"]);
  const command = scripts.resolve(path.join(cwd, "build"));
  expect(command).toEqual({ kind: "script", name: "build", args: ["--mode", "a b", "$HOME"] });
  await scripts.run(command);
  expect(spawned).toEqual([
    { argv: ["/bin/bash", "-c", "echo pre"], event: "prebuild", script: "echo pre" },
    { argv: ["/bin/bash", "-c", 'vite build --mode "a b" "\\$HOME"'], event: "build", script: "vite build" },
    { argv: ["/bin/bash", "-c", "echo post"], event: "postbuild", script: "echo post" },
  ]);
  expect(stderr()).toBe('$ echo pre\n$ vite build --mode "a b" "\\$HOME"\n$ echo post\n');
  expect(guest.env.npm_execpath).toBe("/bin/bun");
  expect(guest.env.PATH!.split(":").slice(0, 2)).toEqual([path.join(cwd, "node_modules/.bin"), path.join(path.dirname(cwd), "node_modules/.bin")]);
  expect(guest.exitCode).toBeUndefined();
}));

test("a failing script stops the run with Bun's message and its exit code", () => project({ test: "exit 3", posttest: "echo never", quiet: "exit 2", killed: "sleep 9", interrupted: "sleep 9" }, async cwd => {
  for (const [name, exit, message] of [
    ["test", { code: 3 }, 'error: script "test" exited with code 3\n'],
    ["quiet", { code: 2 }, ""],
    ["killed", { code: 143, signal: "SIGTERM" }, 'error: script "killed" was terminated by signal SIGTERM\n'],
    ["interrupted", { code: 130, signal: "SIGINT" }, ""],
  ] as const) {
    const { scripts, spawned, guest, stderr } = runtime(cwd, name, [], { exits: { [name]: exit } });
    await scripts.run(scripts.resolve(path.join(cwd, name)));
    expect(spawned.map(child => child.event)).toEqual([name]);
    expect(stderr().split("\n").slice(1).join("\n")).toBe(message);
    expect(guest.exitCode).toBe(exit.code);
  }
}));

test("--silent hides the command lines and failure messages", () => project({ fails: "exit 5" }, async cwd => {
  const { scripts, stderr, guest } = runtime(cwd, "fails", [], { exits: { fails: { code: 5 } }, execArgv: ["--silent"] });
  await scripts.run(scripts.resolve(path.join(cwd, "fails")));
  expect(stderr()).toBe("");
  expect(guest.exitCode).toBe(5);
}));

test("npm, yarn and pnpm invocations become bun, as Bun's lifecycle script runner rewrites them", () => project({}, async cwd => {
  const cases: [string, string][] = [
    ["npm run build", "bun run build"],
    ["npx vite --host", "bun x vite --host"],
    ["yarn run dev", "bun run dev"],
    ["yarn dev --port 1", "bun run dev --port 1"],
    ["yarn add left-pad", "yarn add left-pad"],
    ["yarn --version", "yarn --version"],
    ["pnpm run lint", "bun run lint"],
    ["pnpm dlx create-vite", "bun x create-vite"],
    ["pnpx tsc", "bun x tsc"],
    ["tsc && npm run test", "tsc && bun run test"],
    ["tsc &&npm run test", "tsc &&npm run test"],
    ['echo "npm run x"', 'echo "bun run x"'],
    ["mynpm run x", "mynpm run x"],
  ];
  for (const [script, rewritten] of cases) {
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { go: script } }));
    const { scripts, spawned } = runtime(cwd, "go");
    await scripts.run(scripts.resolve(path.join(cwd, "go")));
    expect([script, spawned[0]?.argv[2]]).toEqual([script, rewritten]);
    expect(spawned[0]?.script).toBe(script);
  }
}));

test("a name without a script runs a source file first, then an installed package binary", () => project({}, cwd => {
  mkdirSync(path.join(cwd, "node_modules/tool/bin"), { recursive: true });
  mkdirSync(path.join(cwd, "node_modules/.bin"), { recursive: true });
  writeFileSync(path.join(cwd, "node_modules/tool/bin/cli.js"), "#!/usr/bin/env node\n");
  symlinkSync("../tool/bin/cli.js", path.join(cwd, "node_modules/.bin/tool"));
  const bin = runtime(cwd, "tool", ["x"]);
  expect(bin.scripts.resolve(path.join(cwd, "tool"))).toBe(path.join(cwd, "node_modules/tool/bin/cli.js"));
  expect(bin.guest.argv).toEqual(["bun", path.join(cwd, "node_modules/tool/bin/cli.js"), "x"]);
  writeFileSync(path.join(cwd, "tool.ts"), "");
  expect(runtime(cwd, "tool").scripts.resolve(path.join(cwd, "tool"))).toBe(path.join(cwd, "tool.ts"));
  expect(bin.spawned).toEqual([]);
}));
