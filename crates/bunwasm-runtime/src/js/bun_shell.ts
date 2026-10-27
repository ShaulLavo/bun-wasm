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

  type Redirect = { kind: "input"; value: Parameters<typeof bytesOf>[0] } | { kind: "output"; target: ArrayBufferView };
  type Quote = "" | "'" | "\"" | "$'" | "#";

  // The shell's quoting state at the end of `script`, so an interpolation stays one literal word
  // inside "...", '...' and $'...'. Comments run to the end of their line. Each $(...) starts a
  // fresh quoting context; a backtick substitution is reported as "`" so it can be rejected.
  type Frame = { quote: Quote; kind: "top" | "sub" | "tick"; parens: number };
  function quoteState(script: string): Quote | "`" {
    const frames: Frame[] = [{ quote: "", kind: "top", parens: 0 }];
    for (let index = 0; index < script.length; index++) {
      const frame = frames[frames.length - 1];
      const char = script[index];
      if (frame.quote === "#") {
        if (char === "\n") frame.quote = "";
        continue;
      }
      if (frame.quote === "'") {
        if (char === "'") frame.quote = "";
        continue;
      }
      if (char === "\\") { index++; continue; }
      if (frame.quote === "$'") {
        if (char === "'") frame.quote = "";
        continue;
      }
      if (char === "$" && script[index + 1] === "(") { frames.push({ quote: "", kind: "sub", parens: 0 }); index++; continue; }
      if (char === "`") {
        if (frame.kind === "tick" && !frame.quote) frames.pop();
        else frames.push({ quote: "", kind: "tick", parens: 0 });
        continue;
      }
      if (frame.quote === "\"") {
        if (char === "\"") frame.quote = "";
        continue;
      }
      if (char === "$" && script[index + 1] === "'") { frame.quote = "$'"; index++; }
      else if (char === "'" || char === "\"") frame.quote = char;
      else if (char === "#" && (index === 0 || /[\s;&|()]/.test(script[index - 1]))) frame.quote = "#";
      else if (char === "(" && frame.kind === "sub") frame.parens++;
      else if (char === ")" && frame.kind === "sub" && frame.parens-- === 0) frames.pop();
    }
    return frames.some(frame => frame.kind === "tick") ? "`" : frames[frames.length - 1].quote;
  }
  function quoted(text: string, state: Quote): string {
    const inner = text.replace(/[$`"\\]/g, char => "\\" + char);
    if (state === "\"") return inner;
    // Close the quotes, add a double-quoted word, and reopen them.
    if (state === "'") return `'"${inner}"'`;
    if (state === "$'") return `'"${inner}"$'`;
    return escape(text);
  }

  // Interpolations are single words, as in Bun: strings are escaped, arrays become one word
  // per element, { raw } is inserted as written, and JS objects after < or > become files.
  // A redirect is a NUL-delimited index (NUL cannot occur in a shell command) replaced by its
  // private file path when the command runs.
  function interpolate(raw: readonly string[], values: readonly unknown[], redirects: Redirect[]): string {
    let script = raw[0];
    values.forEach((value, index) => {
      const state = quoteState(script);
      if (state === "`") throw new TypeError("Bun.$ cannot interpolate inside a `...` command substitution; use $(...)");
      script += word(value, script, state, redirects) + raw[index + 1];
    });
    return script;
  }
  function word(value: unknown, before: string, state: Quote, redirects: Redirect[]): string {
    if (Array.isArray(value)) return value.map(item => word(item, before, state, redirects)).join(" ");
    if (value && typeof value === "object" && "raw" in value) return String(value.raw);
    if (isBunFile(value)) return quoted(value.name, state);
    if (!binary(value)) return quoted(String(value), state);
    const redirect = state ? undefined : /([<>])\s*$/.exec(before)?.[1];
    if (!redirect) throw new TypeError("Bun.$ accepts binary JavaScript objects only as < or > redirect targets");
    if (redirect === "<") redirects.push({ kind: "input", value });
    else if (ArrayBuffer.isView(value)) redirects.push({ kind: "output", target: value });
    else throw new TypeError("Bun.$ can redirect output only into a Buffer, TypedArray or Bun.file()");
    return `\0${redirects.length - 1}\0`;
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
    setEnv(env: Env) { this.env = { ...env }; }
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
    const fs = internal.builtin("node:fs");
    const cwd = parsed.cwd ?? process.cwd();
    const env = parsed.env ?? { ...process.env };
    // A private directory owns every redirect file, so cleanup removes only what this run made.
    const directory = parsed.redirects.length ? fs.mkdtempSync(path.resolve(process.env.TMPDIR || "/tmp", "bun-shell-")) : undefined;
    try {
      const files = parsed.redirects.map((_, index) => path.resolve(directory!, String(index)));
      for (const [index, redirect] of parsed.redirects.entries()) {
        if (redirect.kind === "input") fs.writeFileSync(files[index], await bytesOf(redirect.value), { flag: "wx" });
      }
      const script = parsed.script.replace(/\0(\d+)\0/g, (_, index: string) => quoted(files[Number(index)], ""));
      const child = internal.require("spawn").spawn([findShell(env, cwd), "-c", script], {
        cwd, env, stdin: "inherit", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        collect(child.stdout, parsed.quiet ? undefined : process.stdout),
        collect(child.stderr, parsed.quiet ? undefined : process.stderr),
        child.exited,
      ]);
      for (const [index, redirect] of parsed.redirects.entries()) {
        if (redirect.kind !== "output" || !fs.existsSync(files[index])) continue;
        const written = fs.readFileSync(files[index]);
        const target = new Uint8Array(redirect.target.buffer, redirect.target.byteOffset, redirect.target.byteLength);
        target.set(written.subarray(0, target.length));
      }
      return { code, stdout, stderr };
    } finally {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
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

  // Bun.$.braces: comma lists only, nested, like Bun (no {1..3} sequences).
  function braces(pattern: string): string[] {
    const open = pattern.indexOf("{");
    if (open < 0) return [pattern];
    let depth = 0;
    const commas: number[] = [];
    for (let index = open; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\") { index++; continue; }
      if (char === "{") depth++;
      else if (char === "," && depth === 1) commas.push(index);
      else if (char === "}" && --depth === 0) {
        const prefix = pattern.slice(0, open);
        const suffix = pattern.slice(index + 1);
        if (!commas.length) return braces(suffix).map(tail => pattern.slice(0, index + 1) + tail);
        const items = commas.concat(index).map((end, at) => pattern.slice(at ? commas[at - 1] + 1 : open + 1, end));
        return items.flatMap(item => braces(prefix + item + suffix));
      }
    }
    return [pattern];
  }

  return { $: BunShell, findShell };
})
