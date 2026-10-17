(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  const process = internal.require("process");
  const path = internal.require("path");

  function words(source: string): string[] {
    const result: string[] = [];
    let word = "";
    let quote = "";
    let started = false;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === "\\" && quote !== "'") {
        if (++index === source.length) throw new SyntaxError("Trailing escape in package script");
        word += source[index]; started = true; continue;
      }
      if (char === quote) { quote = ""; continue; }
      if ((char === "'" || char === '"') && !quote) { quote = char; started = true; continue; }
      if (!quote && /[|&;<>`\n]/.test(char)) throw new Error("Shell operators in package scripts are not supported in bun-wasm");
      if (!quote && /\s/.test(char)) {
        if (started) result.push(word);
        word = ""; started = false; continue;
      }
      if (char === "$" && quote !== "'") {
        const variable = /^(?:\{([A-Za-z_][\w]*)\}|([A-Za-z_][\w]*))/.exec(source.slice(index + 1));
        if (variable) { word += process.env[variable[1] || variable[2]] || ""; index += variable[0].length; started = true; continue; }
      }
      word += char; started = true;
    }
    if (quote) throw new SyntaxError("Unclosed quote in package script");
    if (started) result.push(word);
    return result;
  }

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

  function binPath(base: string, file: unknown): string {
    if (typeof file !== "string") throw new TypeError("Package bin must be a string");
    if (file.startsWith("/") || file.split("/").includes("..")) throw new Error("Invalid package bin path");
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
    } else if ("bin" in meta && meta.bin && typeof meta.bin === "object") {
      if (Object.prototype.hasOwnProperty.call(meta.bin, name)) file = binPath(base, Reflect.get(meta.bin, name));
    } else if ("directories" in meta && meta.directories && typeof meta.directories === "object" && "bin" in meta.directories) {
      file = path.resolve(binPath(base, meta.directories.bin), name);
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
    return packages.sort();
  }

  function binary(cwd: string, name: string): string | undefined {
    if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return;
    for (;;) {
      const modules = path.resolve(cwd, "node_modules");
      const bin = path.resolve(modules, ".bin", name);
      if (native.exists(bin)) return bin;
      for (const base of packageDirectories(modules)) {
        const file = manifestBinary(base, name);
        if (file) return file;
      }
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

  function resolve(requested: string): string {
    const cwd = process.cwd();
    let name = native.mainArg();
    let args = process.argv.slice(2);
    let file = requested;
    const bins: string[] = [];
    for (let directory = cwd;; directory = path.dirname(directory)) {
      bins.push(path.resolve(directory, "node_modules", ".bin"));
      if (path.dirname(directory) === directory) break;
    }
    process.env.PATH = bins.concat(process.env.PATH ? [process.env.PATH] : []).join(":");
    for (let depth = 0; depth < 32; depth++) {
      const command = name && !name.includes("/") ? script(cwd, name) : undefined;
      if (command === undefined) { file = binary(cwd, name) || path.resolve(cwd, name || requested); break; }
      const argv = words(command);
      while (argv.length && /^[A-Za-z_][\w]*=/.test(argv[0])) {
        const entry = argv.shift();
        if (entry === undefined) break;
        const equals = entry.indexOf("=");
        process.env[entry.slice(0, equals)] = entry.slice(equals + 1);
      }
      let executable = argv.shift();
      if (!executable) throw new Error(`Package script ${name} has no executable`);
      process.env.npm_lifecycle_event = name;
      process.env.npm_lifecycle_script = command;
      process.env.npm_execpath = process.execPath;
      if (["bun", "node", "nodejs"].includes(path.basename(executable))) {
        while (["--bun", "--smol", "--silent"].includes(argv[0])) argv.shift();
        if (argv[0] === "run") argv.shift();
        executable = argv.shift();
        if (!executable) throw new Error(`Package script ${name} needs a file`);
      }
      args = argv.concat(args);
      name = executable;
      if (depth === 31) throw new Error("Package script recursion limit exceeded");
    }
    file = dereference(file);
    process.argv.splice(1, process.argv.length - 1, file, ...args);
    native.setMainPath(file);
    internal.mainPath = file;
    return file;
  }
  function spawnArguments(argv: string[], directory: unknown): string[] {
    if (["bunx", "/bunx"].includes(argv[0])) return ["bun", "x"].concat(argv.slice(1));
    const cwd = directory instanceof URL ? decodeURIComponent(directory.pathname) : path.resolve(process.cwd(), String(directory || process.cwd()));
    const executable = binary(cwd, argv[0]);
    if (!executable) return argv;
    return ["bun", dereference(executable)].concat(argv.slice(1));
  }
  return { resolve, spawnArguments };
})
