// Bun.$ adapted from oven-sh/bun src/js/builtins/shell.ts (docs/bun-patches/bun-shell-on-bash-web.md).
// The promise, output and error classes follow upstream. The interpreter is the system shell
// (bash-web on Waffle), run as `sh -c` the way `bun run` runs package scripts.
(function (internal: BunWasm.Internal) {
  "use strict";
  const process = internal.require("process");
  const path = internal.require("path");
  const { Buffer } = internal.require("buffer");
  type Bytes = BunWasm.BufferBytes;
  type Env = Record<string, string | undefined>;

  // Bun's needs_escape_utf8_ascii_latin1 and escape_8bit (src/shell_parser/parse.rs).
  const special = new Set("~[]#;\n\t\r*?{,}`$=()0123456789|><&'\" \\");
  function needsEscape(value: string): boolean {
    if (!value) return true;
    for (const char of value) if (special.has(char)) return true;
    return false;
  }
  function escape(value: unknown): string {
    const text = String(value);
    if (!needsEscape(text)) return text;
    return '"' + text.replace(/[$`"\\]/g, char => "\\" + char) + '"';
  }

  function isBunFile(value: unknown): value is { name: string } {
    return value instanceof internal.BunFile && typeof (value as { name?: unknown }).name === "string";
  }
  function binary(value: unknown): value is Blob | Response | ArrayBuffer | ArrayBufferView | ReadableStream {
    return value instanceof Blob || value instanceof Response || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof ReadableStream;
  }
  async function bytesOf(value: Blob | Response | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<Uint8Array> {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
    return new Uint8Array(await value.arrayBuffer());
  }

  type Redirect = { kind: "input"; file: string; value: Parameters<typeof bytesOf>[0] } | { kind: "output"; file: string; target: ArrayBufferView };
  let temporaryCounter = 0;
  function temporaryFile(): string {
    return path.resolve(process.env.TMPDIR || "/tmp", `bun-shell-${Date.now()}-${++temporaryCounter}`);
  }

  // Interpolations are single words, as in Bun: strings are escaped, arrays become one word
  // per element, { raw } is inserted as written, and JS objects after < or > become files.
  function interpolate(raw: readonly string[], values: readonly unknown[], redirects: Redirect[]): string {
    let script = raw[0];
    values.forEach((value, index) => {
      script += word(value, script, redirects) + raw[index + 1];
    });
    return script;
  }
  function word(value: unknown, before: string, redirects: Redirect[]): string {
    if (Array.isArray(value)) return value.map(item => word(item, before, redirects)).join(" ");
    if (value && typeof value === "object" && "raw" in value) return String(value.raw);
    if (isBunFile(value)) return escape(value.name);
    const redirect = /([<>])\s*$/.exec(before)?.[1];
    if (binary(value)) {
      if (!redirect) throw new TypeError("Bun.$ accepts binary JavaScript objects only as < or > redirect targets");
      const file = temporaryFile();
      if (redirect === "<") redirects.push({ kind: "input", file, value });
      else if (ArrayBuffer.isView(value)) redirects.push({ kind: "output", file, target: value });
      else throw new TypeError("Bun.$ can redirect output only into a Buffer, TypedArray or Bun.file()");
      return escape(file);
    }
    return escape(value);
  }

  class ParsedShellScript {
    cwd: string | undefined;
    env: Env | undefined;
    quiet = false;
    readonly script: string;
    readonly redirects: Redirect[];
    constructor(script: string, redirects: Redirect[]) {
      this.script = script;
      this.redirects = redirects;
    }
    setCwd(cwd: string) { this.cwd = cwd; }
    setEnv(env: Env) { this.env = env; }
    setQuiet(quiet: boolean) { this.quiet = quiet; }
  }

  // Bun's RunCommand.findShell: bash, then sh, then well-known paths.
  function findShell(env: Env, cwd: string): string {
    const PATH = env.PATH ?? "";
    for (const name of ["bash", "sh"]) {
      const found = internal.require("spawn").which(name, { PATH, cwd });
      if (found) return found;
    }
    return "/bin/sh";
  }

  async function collect(stream: ReadableStream<Uint8Array>, echo: { write(chunk: unknown): unknown } | undefined): Promise<Bytes> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      echo?.write(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function execute(parsed: ParsedShellScript): Promise<{ code: number; stdout: Bytes; stderr: Bytes }> {
    const fs = internal.require("fs");
    const cwd = parsed.cwd ?? process.cwd();
    const env = parsed.env ?? process.env;
    try {
      for (const redirect of parsed.redirects) {
        if (redirect.kind === "input") fs.writeFileSync(redirect.file, await bytesOf(redirect.value));
      }
      const child = internal.require("spawn").spawn([findShell(env, cwd), "-c", parsed.script], {
        cwd, env, stdin: "inherit", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        collect(child.stdout, parsed.quiet ? undefined : process.stdout),
        collect(child.stderr, parsed.quiet ? undefined : process.stderr),
        child.exited,
      ]);
      for (const redirect of parsed.redirects) {
        if (redirect.kind !== "output" || !fs.existsSync(redirect.file)) continue;
        const written = fs.readFileSync(redirect.file);
        const target = new Uint8Array(redirect.target.buffer, redirect.target.byteOffset, redirect.target.byteLength);
        target.set(written.subarray(0, target.length));
      }
      return { code, stdout, stderr };
    } finally {
      for (const redirect of parsed.redirects) fs.rmSync(redirect.file, { force: true });
    }
  }

  function createShellInterpreter(resolve: (code: number, stdout: Bytes, stderr: Bytes) => void, reject: (error: unknown) => void, parsed: ParsedShellScript) {
    return {
      run() {
        execute(parsed).then(({ code, stdout, stderr }) => resolve(code, stdout, stderr), reject);
      },
    };
  }

  function lazyBufferToHumanReadableString(this: Bytes) {
    return this.toString();
  }

  class ShellError extends Error {
    #output?: ShellOutput = undefined;
    declare info: { exitCode: number; stderr: Bytes; stdout: Bytes };
    exitCode!: number;
    stdout!: Bytes;
    stderr!: Bytes;

    constructor() {
      super("");
    }

    initialize(output: ShellOutput, code: number) {
      this.message = `Failed with exit code ${code}`;
      this.#output = output;
      this.name = "ShellError";
      Object.defineProperty(this, "info", {
        value: { exitCode: code, stderr: output.stderr, stdout: output.stdout },
        writable: true,
        enumerable: false,
        configurable: true,
      });
      Object.assign(this.info.stdout, { toJSON: lazyBufferToHumanReadableString });
      Object.assign(this.info.stderr, { toJSON: lazyBufferToHumanReadableString });
      this.stdout = output.stdout;
      this.stderr = output.stderr;
      this.exitCode = code;
    }

    text(encoding?: string) { return this.#output!.text(encoding); }
    json() { return this.#output!.json(); }
    arrayBuffer() { return this.#output!.arrayBuffer(); }
    bytes() { return this.#output!.bytes(); }
    blob() { return this.#output!.blob(); }
  }

  class ShellOutput {
    stdout: Bytes;
    stderr: Bytes;
    exitCode: number;
    constructor(stdout: Bytes, stderr: Bytes, exitCode: number) {
      this.stdout = stdout;
      this.stderr = stderr;
      this.exitCode = exitCode;
    }
    text(encoding?: string) { return this.stdout.toString(encoding); }
    json() { return JSON.parse(this.stdout.toString()); }
    arrayBuffer() { return this.stdout.buffer.slice(this.stdout.byteOffset, this.stdout.byteOffset + this.stdout.byteLength); }
    bytes() { return new Uint8Array(this.arrayBuffer()); }
    blob() { return new Blob([this.stdout as BlobPart]); }
  }

  class ShellPromise extends Promise<ShellOutput> {
    #args: ParsedShellScript | undefined = undefined;
    #hasRun = false;
    #throws = true;
    #resolve: (code: number, stdout: Bytes, stderr: Bytes) => void;
    #reject: (error: unknown) => void;

    constructor(args: ParsedShellScript, throws: boolean) {
      // Created now so the stack points at the $`...` call, as in Bun.
      let potentialError: ShellError | undefined = new ShellError();
      let resolve!: (code: number, stdout: Bytes, stderr: Bytes) => void;
      let reject!: (error: unknown) => void;
      super((res, rej) => {
        resolve = (code, stdout, stderr) => {
          const out = new ShellOutput(stdout, stderr, code);
          if (this.#throws && code !== 0) {
            potentialError!.initialize(out, code);
            rej(potentialError);
          } else {
            potentialError = undefined;
            res(out);
          }
        };
        reject = error => {
          potentialError = undefined;
          rej(error);
        };
      });
      this.#throws = throws;
      this.#args = args;
      this.#resolve = resolve;
      this.#reject = reject;
    }

    cwd(newCwd?: string): this {
      this.#throwIfRunning();
      if (newCwd === undefined || newCwd === "." || newCwd === "" || newCwd === "./") newCwd = defaultCwd ?? process.cwd();
      this.#args!.setCwd(newCwd);
      return this;
    }

    env(newEnv?: Env): this {
      this.#throwIfRunning();
      this.#args!.setEnv(newEnv === undefined ? defaultEnv : newEnv);
      return this;
    }

    #run() {
      if (this.#hasRun) return;
      this.#hasRun = true;
      try {
        const interp = createShellInterpreter(this.#resolve, this.#reject, this.#args!);
        this.#args = undefined;
        interp.run();
      } catch (error) {
        this.#args = undefined;
        this.#reject(error);
      }
    }

    #quiet(isQuiet = true): this {
      this.#throwIfRunning();
      this.#args!.setQuiet(isQuiet);
      return this;
    }

    quiet(isQuiet?: boolean): this { return this.#quiet(isQuiet ?? true); }
    nothrow(): this { this.#throws = false; return this; }
    throws(doThrow?: boolean): this { this.#throws = !!doThrow; return this; }

    async text(encoding?: string) {
      const { stdout } = await this.#quiet(true);
      return stdout.toString(encoding);
    }
    async json() {
      const { stdout } = await this.#quiet(true);
      return JSON.parse(stdout.toString());
    }
    async *lines() {
      const { stdout } = await this.#quiet(true);
      yield* stdout.toString().split("\n");
    }
    async arrayBuffer() {
      return (await this.#quiet(true)).arrayBuffer();
    }
    async bytes() {
      return new Uint8Array(await this.arrayBuffer());
    }
    async blob() {
      const { stdout } = await this.#quiet(true);
      return new Blob([stdout as BlobPart]);
    }

    #throwIfRunning() {
      if (this.#hasRun) throw new Error("Shell is already running");
    }

    run(): this {
      this.#run();
      return this;
    }

    override then<TResult1 = ShellOutput, TResult2 = never>(
      onfulfilled?: ((value: ShellOutput) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      this.#run();
      return super.then(onfulfilled, onrejected);
    }

    static override get [Symbol.species]() {
      return Promise;
    }
  }

  let defaultEnv: Env = process.env || {};
  const originalDefaultEnv = defaultEnv;
  let defaultCwd: string | undefined = undefined;

  const cwdSymbol = Symbol("cwd");
  const envSymbol = Symbol("env");
  const throwsSymbol = Symbol("throws");
  type Settings = { [cwdSymbol]?: string; [envSymbol]?: Env; [throwsSymbol]: boolean };

  class ShellPrototype {
    [cwdSymbol]: string | undefined;
    [envSymbol]: Env | undefined;
    [throwsSymbol] = true;

    env(newEnv?: Env) {
      if (newEnv === undefined || newEnv === originalDefaultEnv) this[envSymbol] = originalDefaultEnv;
      else if (newEnv) this[envSymbol] = Object.assign({}, newEnv);
      else throw new TypeError("env must be an object or undefined");
      return this;
    }

    cwd(newCwd?: string) {
      if (newCwd !== undefined && typeof newCwd !== "string") throw new TypeError("cwd must be a string or undefined");
      if (newCwd === "." || newCwd === "" || newCwd === "./") newCwd = defaultCwd ?? process.cwd();
      this[cwdSymbol] = newCwd;
      return this;
    }

    nothrow() {
      this[throwsSymbol] = false;
      return this;
    }

    throws(doThrow?: boolean) {
      this[throwsSymbol] = !!doThrow;
      return this;
    }
  }

  function template(settings: Settings, first: TemplateStringsArray, rest: unknown[]) {
    if (first?.raw === undefined) throw new Error("Please use '$' as a tagged template function: $`cmd arg1 arg2`");
    const redirects: Redirect[] = [];
    const parsed = new ParsedShellScript(interpolate(first.raw, rest, redirects), redirects);
    const cwd = settings[cwdSymbol];
    const env = settings[envSymbol];
    if (cwd) parsed.setCwd(cwd);
    if (env) parsed.setEnv(env);
    return new ShellPromise(parsed, settings[throwsSymbol]);
  }

  const BunShell = function BunShell(first: TemplateStringsArray, ...rest: unknown[]) {
    return template(BunShell as unknown as Settings, first, rest);
  };

  function Shell(this: unknown) {
    if (!new.target) throw new TypeError("Class constructor Shell cannot be invoked without 'new'");
    const Shell = function Shell(first: TemplateStringsArray, ...rest: unknown[]) {
      return template(Shell as unknown as Settings, first, rest);
    };
    const prototype: unknown = new.target.prototype;
    Object.setPrototypeOf(Shell, prototype && typeof prototype === "object" ? prototype : ShellPrototype.prototype);
    Object.defineProperty(Shell, "name", { value: "Shell", configurable: true, enumerable: true });
    Object.assign(Shell, { [cwdSymbol]: defaultCwd, [envSymbol]: defaultEnv, [throwsSymbol]: true });
    return Shell;
  }

  Shell.prototype = ShellPrototype.prototype;
  Object.setPrototypeOf(Shell, ShellPrototype);
  Object.setPrototypeOf(BunShell, ShellPrototype.prototype);
  Object.assign(BunShell, { [cwdSymbol]: defaultCwd, [envSymbol]: defaultEnv, [throwsSymbol]: true });

  Object.defineProperties(BunShell, {
    Shell: { value: Shell, enumerable: true },
    ShellPromise: { value: ShellPromise, enumerable: true },
    ShellError: { value: ShellError, enumerable: true },
    escape: { value: (value: unknown) => escape(value), enumerable: true, writable: true, configurable: true },
    braces: { value: braces, enumerable: true, writable: true, configurable: true },
  });

  // Bun's Bun.$.braces: Bash brace expansion of comma lists and numeric or letter sequences.
  function braces(pattern: string): string[] {
    const open = pattern.indexOf("{");
    if (open < 0) return [pattern];
    let depth = 0;
    const commas: number[] = [];
    for (let index = open; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\") { index++; continue; }
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        const body = pattern.slice(open + 1, index);
        const prefix = pattern.slice(0, open);
        const suffix = pattern.slice(index + 1);
        const items = commas.length ? split(body, commas.map(at => at - open - 1)) : sequence(body);
        if (!items) return [prefix + "{" + body + "}"].flatMap(head => braces(suffix).map(tail => head + tail));
        return items.flatMap(item => braces(prefix + item + suffix));
      } else if (char === "," && depth === 1) commas.push(index);
    }
    return [pattern];
  }
  function split(body: string, at: number[]): string[] {
    return at.concat(body.length).map((end, index) => body.slice(index ? at[index - 1] + 1 : 0, end));
  }
  function sequence(body: string): string[] | undefined {
    const match = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(body);
    if (!match) return;
    const numeric = /\d/.test(match[1]);
    if (numeric !== /\d/.test(match[2])) return;
    const start = numeric ? Number(match[1]) : match[1].charCodeAt(0);
    const end = numeric ? Number(match[2]) : match[2].charCodeAt(0);
    const step = Math.abs(Number(match[3] ?? 1)) || 1;
    const items: string[] = [];
    for (let value = start; start <= end ? value <= end : value >= end; value += start <= end ? step : -step)
      items.push(numeric ? String(value) : String.fromCharCode(value));
    return items;
  }

  return { $: BunShell, findShell };
})
