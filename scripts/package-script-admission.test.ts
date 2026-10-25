import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const bootstrap = read("crates/bunwasm-runtime/src/js/bootstrap.js");
const start = bootstrap.indexOf("  internal.runMain =");
const end = bootstrap.indexOf("  internal.getMainModule", start);
const registry = read("crates/bunwasm-host/src/process/executables.rs");
const paths = registry.slice(registry.indexOf("pub const DEFAULT_PATHS"), registry.indexOf("/// A launcher-owned"));
const registered = new Set(Array.from(paths.matchAll(/"(\/[^"]+)"/g), match => match[0].slice(1, -1)));
const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true }); });

// Run both production factories and runMain. Stop at procSpawn, before creating a guest.
function fixture(command: string, admitted: ReadonlySet<string> = registered) {
  const cwd = mkdtempSync(path.join(tmpdir(), "bun-wasm-script-admission-"));
  projects.push(cwd);
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { start: command, "app.js": "bun run start" } }));
  writeFileSync(path.join(cwd, "app.js"), "throw new Error('not executed by this source control');");
  const guestProcess = { env: { PATH: "/bin:/usr/bin" }, argv: ["bun", "start", "tail"], execPath: "/bin/bun", cwd: () => cwd };
  const attempts: string[] = [], launches: unknown[] = [];
  const marker = new Error("reached procSpawn; guest execution deliberately excluded");
  const native = {
    mainArg: () => "start", exists: existsSync, readFileUtf8: (file: string) => readFileSync(file, "utf8"),
    stat: (file: string, link = false) => link ? lstatSync(file) : statSync(file), readlink: readlinkSync,
    readdir: (directory: string) => readdirSync(directory, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? "dir" : "file"]),
    resolve: (file: string) => file, setMainPath() {}, hostCaps: { proc_spawn: true }, cwd: () => cwd,
    procAccess(file: string) { attempts.push(file); return admitted.has(file) ? 0 : -44; },
    procJobOf: () => 1,
    procSpawn(request: string) { launches.push(JSON.parse(request)); throw marker; },
  };
  function emit(file: string) {
    return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${read(file)}`), { process: guestProcess, URL });
  }
  const internal = { native, mainPath: "", web: {}, require, runMain: (_requested: string): Promise<void> => Promise.resolve() };
  const packages = emit("crates/bunwasm-runtime/src/js/package_scripts.ts")(internal);
  const spawn = emit("crates/bunwasm-runtime/src/js/spawn.ts")(internal);
  function require(name: string): unknown {
    if (name === "process") return guestProcess;
    if (name === "path") return path;
    if (name === "buffer") return { Buffer };
    if (name === "package_scripts") return packages;
    if (name === "spawn") return spawn;
    throw new Error(`Unexpected dependency: ${name}`);
  }
  runInNewContext(bootstrap.slice(start, end), { internal, native });
  return { cwd, attempts, launches, marker, run: () => internal.runMain(path.join(cwd, "start")) };
}

for (const directory of ["/bin", "/opt/bun/quickjs/bin", "/opt/bun/jsc/bin"]) {
  for (const executable of ["node", "nodejs"]) test(`${directory}/${executable} admits file and eval through the production dispatch chain`, async () => {
    for (const operands of [["./app.js", "first"], ["-e", "console.log(42)"]]) {
      const command = `PATH=${directory} MODE=kept ${executable} ${operands.map(arg => JSON.stringify(arg)).join(" ")}`;
      const f = fixture(command);
      await expect(f.run()).rejects.toBe(f.marker);
      expect(f.launches).toEqual([{ executable: `${directory}/${executable}`, argv: [executable].concat(operands, ["tail"]),
        cwd: f.cwd, env: { PATH: directory, MODE: "kept", npm_lifecycle_event: "start", npm_lifecycle_script: command, npm_execpath: "/bin/bun" },
        job: 1, fds: [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }],
      }]);
      expect(f.attempts).toEqual([`${directory}/${executable}`]);
    }
  });
}

for (const command of ["PATH=/restricted nodejs ./app.js", "PATH= nodejs ./app.js", "PATH=/bin /missing/nodejs ./app.js"]) {
  test(`runtime aliases cannot escape admission: ${command}`, async () => {
    const f = fixture(command);
    await expect(f.run()).rejects.toMatchObject({ code: "ENOENT", syscall: "spawn" });
    expect(f.launches).toEqual([]);
    expect(f.attempts).not.toContain("/bin/node");
    expect(f.attempts).not.toContain("/bin/nodejs");
  });
}

test("nodejs respects earlier PATH entries and keeps argv[0]", async () => {
  const f = fixture("PATH=/custom:/bin nodejs ./app.js", new Set(Array.from(registered).concat("/custom/nodejs")));
  await expect(f.run()).rejects.toBe(f.marker);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({ executable: "/custom/nodejs", argv: ["nodejs", "./app.js", "tail"] });
  expect(f.attempts).toEqual(["/custom/nodejs"]);
});

test("revoking nodejs does not silently fall back to node", async () => {
  const f = fixture("PATH=/bin nodejs ./app.js", new Set(["/bin/bun", "/bin/node"]));
  await expect(f.run()).rejects.toMatchObject({ code: "ENOENT", path: "nodejs" });
  expect(f.launches).toEqual([]);
  expect(f.attempts).toEqual(["/bin/nodejs"]);
});

test("installed nodejs binary still wins over the runtime name", async () => {
  const f = fixture("nodejs ./app.js");
  const bin = path.join(f.cwd, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const entry = path.join(bin, "nodejs");
  writeFileSync(entry, "console.log('installed bin');");
  await expect(f.run()).rejects.toBe(f.marker);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]).toMatchObject({ executable: "/bin/bun", argv: ["bun", entry, "./app.js", "tail"] });
});

for (const directory of ["/bin", "/opt/bun/quickjs/bin", "/opt/bun/jsc/bin"]) {
  test(`explicit ${directory}/nodejs bypasses PATH without rewriting its argv`, async () => {
    const executable = `${directory}/nodejs`;
    const f = fixture(`PATH=/restricted ${executable} ./app.js`);
    await expect(f.run()).rejects.toBe(f.marker);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ executable, argv: [executable, "./app.js", "tail"] });
    expect(f.attempts).toEqual([executable]);
  });
}
