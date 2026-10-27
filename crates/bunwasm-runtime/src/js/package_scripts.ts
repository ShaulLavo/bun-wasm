// `bun run <script>` runs package.json scripts in the system shell (bash-web's /bin/sh), the way
// Bun's run_command.rs does with its system shell (docs/bun-patches/package-scripts-through-the-shell.md).
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const process = internal.require("process");
  const path = internal.require("path");

  function script(cwd: string, name: string): string | undefined {
    const manifest = path.resolve(cwd, "package.json");
    if (!native.exists(manifest)) return;
    const value: unknown = JSON.parse(native.readFileUtf8(manifest));
    if (!value || typeof value !== "object" || !("scripts" in value)) return;
    const scripts = value.scripts;
    if (!scripts || typeof scripts !== "object" || !Object.prototype.hasOwnProperty.call(scripts, name)) return;
    const command: unknown = Reflect.get(scripts, name);
    if (typeof command !== "string") throw new TypeError(`Package script ${name} must be a string`);
    return command;
  }

  function binPath(base: string, file: unknown): string | undefined {
    if (typeof file !== "string" || !file || file.startsWith("/") || file.split("/").includes("..")) return;
    return path.resolve(base, file);
  }

  function manifestBinary(base: string, name: string): string | undefined {
    const manifest = path.resolve(base, "package.json");
    if (!native.exists(manifest)) return;
    const meta: unknown = JSON.parse(native.readFileUtf8(manifest));
    if (!meta || typeof meta !== "object") return;
    let file: string | undefined;
    if ("bin" in meta && typeof meta.bin === "string") {
      if ("name" in meta && typeof meta.name === "string" && meta.name.split("/").pop() === name) file = binPath(base, meta.bin);
    } else if ("bin" in meta && meta.bin && typeof meta.bin === "object" && !Array.isArray(meta.bin)) {
      if (Object.prototype.hasOwnProperty.call(meta.bin, name)) file = binPath(base, Reflect.get(meta.bin, name));
    } else if ("directories" in meta && meta.directories && typeof meta.directories === "object" && "bin" in meta.directories) {
      const directory = binPath(base, meta.directories.bin);
      if (directory) file = path.resolve(directory, name);
    }
    if (file && native.exists(file) && (native.stat(file).mode & 0o170000) === 0o100000) return file;
  }

  function packageDirectories(modules: string): string[] {
    if (!native.exists(modules)) return [];
    const packages: string[] = [];
    for (const [name, kind] of native.readdir(modules)) {
      if (name.startsWith(".") || (kind !== "dir" && kind !== "symlink")) continue;
      const base = path.resolve(modules, name);
      if (!name.startsWith("@")) { packages.push(base); continue; }
      for (const [child] of native.readdir(base)) packages.push(path.resolve(base, child));
    }
    return packages.sort().reverse();
  }

  function moduleBinary(modules: string, name: string): string | undefined {
    const bin = path.resolve(modules, ".bin", name);
    if (native.exists(bin)) return bin;
    for (const base of packageDirectories(modules)) {
      const file = manifestBinary(base, name);
      if (file) return file;
    }
  }

  function binary(cwd: string, name: string): string | undefined {
    if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return;
    for (;;) {
      const file = moduleBinary(path.resolve(cwd, "node_modules"), name);
      if (file) return file;
      const parent = path.dirname(cwd);
      if (parent === cwd) return;
      cwd = parent;
    }
  }

  function dereference(file: string) {
    for (let depth = 0; depth < 40; depth++) {
      if (!native.exists(file)) return file;
      if ((native.stat(file, true).mode & 0o170000) !== 0o120000) return file;
      file = path.resolve(path.dirname(file), native.readlink(file));
    }
    throw Object.assign(new Error("Too many symbolic links in package binary"), { code: "ELOOP" });
  }

  function sourceFile(cwd: string, name: string): string | undefined {
    try {
      const file = native.resolve(path.resolve(cwd, name), "/", false);
      if (native.exists(file) && (native.stat(file).mode & 0o170000) === 0o100000) return file;
    } catch {}
  }

  function scripts(cwd: string): Record<string, unknown> {
    const manifest = path.resolve(cwd, "package.json");
    if (!native.exists(manifest)) return {};
    const value: unknown = JSON.parse(native.readFileUtf8(manifest));
    if (!value || typeof value !== "object" || !("scripts" in value) || !value.scripts || typeof value.scripts !== "object") return {};
    return value.scripts as Record<string, unknown>;
  }

  function resolve(requested: string): string | BunWasm.ScriptRuntimeCommand {
    const cwd = process.cwd();
    const name = native.mainArg();
    const bins: string[] = [];
    for (let directory = cwd;; directory = path.dirname(directory)) {
      bins.push(path.resolve(directory, "node_modules", ".bin"));
      if (path.dirname(directory) === directory) break;
    }
    process.env.PATH = bins.concat(process.env.PATH ?? "/bin:/usr/bin").join(":");
    if (name && !name.includes("/") && script(cwd, name) !== undefined) return { kind: "script", name, args: process.argv.slice(2) };
    const file = dereference(sourceFile(cwd, name || requested) || binary(cwd, name) || path.resolve(cwd, name || requested));
    process.argv.splice(1, process.argv.length - 1, file, ...process.argv.slice(2));
    native.setMainPath(file);
    internal.mainPath = file;
    return file;
  }

  // Bun's lifecycle_script_runner.rs replace_package_manager_run: npm/yarn/pnpm run and npx become bun.
  const yarnCommands = new Set(["access", "add", "audit", "autoclean", "bin", "cache", "check", "config", "create", "dedupe", "dlx", "exec", "explain", "generate-lock-entry", "generateLockEntry", "global", "help", "import", "info", "init", "install", "licenses", "link", "list", "login", "logout", "node", "npm", "outdated", "owner", "pack", "patch", "plugin", "policies", "publish", "rebuild", "remove", "run", "set", "tag", "team", "unlink", "unplug", "up", "upgrade", "upgrade-interactive", "upgradeInteractive", "version", "versions", "why", "workspace", "workspaces"]);
  function replacePackageManagerRun(script: string): string {
    let out = "";
    let delimiter = " ";
    for (let index = 0; index < script.length;) {
      const rest = script.slice(index);
      const char = script[index];
      const replaced = delimiter ? packageManagerCommand(rest) : undefined;
      if (replaced) {
        out += replaced.text;
        index += replaced.length;
        delimiter = "";
        continue;
      }
      delimiter = char === " " || char === "\"" || char === "'" ? char : "";
      out += char;
      index++;
    }
    return out;
  }
  function packageManagerCommand(rest: string): { text: string; length: number } | undefined {
    if (rest.startsWith("npm run ")) return { text: "bun run ", length: "npm run ".length };
    if (rest.startsWith("npx ")) return { text: "bun x ", length: "npx ".length };
    if (rest.startsWith("pnpm run ")) return { text: "bun run ", length: "pnpm run ".length };
    if (rest.startsWith("pnpm dlx ")) return { text: "bun x ", length: "pnpm dlx ".length };
    if (rest.startsWith("pnpx ")) return { text: "bun x ", length: "pnpx ".length };
    if (!rest.startsWith("yarn ")) return;
    const command = /^yarn (\S+) /.exec(rest)?.[1];
    if (!command || command === "npm" || command.startsWith("-")) return;
    if (command === "run") return { text: "bun run", length: "yarn run".length };
    if (!yarnCommands.has(command)) return { text: `bun run ${command}`, length: "yarn ".length + command.length };
  }

  // Bun's escape for passthrough arguments appended to the script.
  function quote(arg: string): string {
    return internal.require("bun_shell").escape(arg);
  }

  function announce(script: string) {
    const colors = Boolean((process as unknown as { stderr: { isTTY?: boolean } }).stderr.isTTY);
    process.stderr.write(colors ? `\x1b[0m\x1b[2m\x1b[35m$\x1b[0m \x1b[2m\x1b[1m${script}\x1b[0m\n` : `$ ${script}\n`);
  }

  /** Bun's run_package_script_foreground with the system shell. Returns false when the run must stop. */
  async function runScript(name: string, original: string, args: readonly string[], silent: boolean): Promise<boolean> {
    process.env.npm_lifecycle_event = name;
    process.env.npm_lifecycle_script = original;
    const script = [replacePackageManagerRun(original)].concat(args.map(quote)).join(" ");
    if (!silent) announce(script);
    const cwd = process.cwd();
    const shell = internal.require("bun_shell").findShell(process.env, cwd);
    const child = internal.require("spawn").spawn([shell, "-c", script], { cwd, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code === 0) return true;
    const signal = child.signalCode;
    if (!silent && signal !== null && signal !== "SIGINT") process.stderr.write(`error: script "${name}" was terminated by signal ${signal}\n`);
    if (!silent && signal === null && code !== 2) process.stderr.write(`error: script "${name}" exited with code ${code}\n`);
    process.exitCode = code;
    return false;
  }

  /** pre<name>, <name> with the passthrough arguments, then post<name>, stopping at the first failure. */
  async function run(command: BunWasm.ScriptRuntimeCommand): Promise<void> {
    const cwd = process.cwd();
    const silent = process.execArgv.includes("--silent");
    process.env.npm_execpath = process.execPath;
    const table = scripts(cwd);
    for (const [name, args] of [["pre" + command.name, []], [command.name, command.args], ["post" + command.name, []]] as const) {
      const body = table[name];
      if (typeof body !== "string") continue;
      if (!await runScript(name, body, args, silent)) return;
    }
  }
  function spawnArguments(argv: string[], directory: unknown): string[] {
    if (["bunx", "/bunx"].includes(argv[0])) return ["bun", "x"].concat(argv.slice(1));
    const cwd = directory instanceof URL ? decodeURIComponent(directory.pathname) : path.resolve(process.cwd(), String(directory || process.cwd()));
    const executable = binary(cwd, argv[0]);
    if (!executable) return argv;
    return ["bun", dereference(executable)].concat(argv.slice(1));
  }
  return { resolve, run, spawnArguments };
})
