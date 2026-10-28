// node:repl and `bun repl`. Evaluation follows oven-sh/bun src/runtime/cli/repl.rs: Bun's
// transpiler in REPL mode hoists declarations, wraps the last expression in { value } and
// turns top-level await into an async IIFE. The line editor is original: the browser terminal
// leaves echo to the program (docs/bun-patches/bun-repl.md).
(function (internal: BunWasm.Internal) {
  "use strict";
  const process = internal.require("process") as unknown as BunWasm.ReplProcess;
  const EventEmitter = internal.require("events") as unknown as new () => BunWasm.NodeEmitter;

  type Options = { prompt?: string; input?: BunWasm.ReplInput; output?: { write(chunk: string): unknown }; useColors?: boolean };
  const Bun = globalThis.Bun as unknown as BunWasm.ReplBun;
  type Command = { help: string; action(this: REPLServer, text: string): void };

  const ERASE_LINE = "\r\x1b[K";

  class REPLServer extends EventEmitter {
    readonly context: typeof globalThis = globalThis;
    readonly commands: Record<string, Command> = Object.create(null);
    readonly history: string[] = [];
    #prompt: string;
    #input: BunWasm.ReplInput;
    #output: { write(chunk: string): unknown };
    #colors: boolean;
    #terminal: boolean;
    #transpiler: { transformSync(code: string): string };
    #line = "";
    #cursor = 0;
    #pending: string[] = [];
    #historyIndex = -1;
    #escape = "";
    #decoder = new TextDecoder();
    #queue: Promise<void> = Promise.resolve();
    #interrupted = false;
    #cancel: (() => void) | undefined;
    #closed = false;
    #onData = (chunk: Uint8Array | string) => this.#data(chunk);
    // Piped input ends after its last line: finish evaluating what was read, then exit.
    #onEnd = () => { this.#queue = this.#queue.then(() => this.close()); };

    #onInterrupt = () => this.#interrupt();

    constructor(options: Options) {
      super();
      this.#prompt = options.prompt ?? "> ";
      this.#input = options.input ?? process.stdin;
      this.#output = options.output ?? process.stdout;
      this.#terminal = Boolean(this.#input.isTTY);
      this.#colors = options.useColors ?? Boolean(process.stdout.isTTY);
      this.#transpiler = new Bun.Transpiler({ loader: "tsx", replMode: true });
      for (const [name, command] of Object.entries(builtinCommands)) this.commands[name] = command;
      // Like Node's REPL, a terminal is put in raw mode: the editor echoes and handles keys itself.
      if (this.#terminal) this.#input.setRawMode?.(true);
      this.#input.on("data", this.#onData);
      this.#input.on("end", this.#onEnd);
      process.on("SIGINT", this.#onInterrupt);
      this.displayPrompt();
    }

    defineCommand(name: string, command: Command | Command["action"]) {
      this.commands[name] = typeof command === "function" ? { help: "", action: command } : command;
    }

    setPrompt(prompt: string) { this.#prompt = prompt; }
    getPrompt() { return this.#prompt; }

    displayPrompt() {
      if (this.#closed || !this.#terminal) return;
      this.#output.write(this.#pending.length ? "... " : this.#prompt);
    }

    clearBufferedCommand() { this.#pending = []; }

    close() {
      if (this.#closed) return;
      this.#closed = true;
      this.#input.off("data", this.#onData);
      this.#input.off("end", this.#onEnd);
      process.off("SIGINT", this.#onInterrupt);
      if (this.#terminal) this.#input.setRawMode?.(false);
      this.#input.pause();
      this.emit("exit");
      this.emit("close");
    }

    #data(chunk: Uint8Array | string) {
      const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
      if (!this.#terminal) return this.#lines(text);
      for (const char of text) this.#key(char);
    }

    #lines(text: string) {
      this.#line += text;
      const lines = this.#line.split(/\r?\n/);
      this.#line = lines.pop() ?? "";
      for (const line of lines) this.#submit(line);
    }

    // A small Emacs-style editor: history, cursor movement and the usual control keys.
    #key(char: string) {
      if (this.#escape) return this.#escapeKey(char);
      const code = char.charCodeAt(0);
      if (char === "\x1b") { this.#escape = char; return; }
      if (char === "\r" || char === "\n") {
        this.#output.write("\r\n");
        const line = this.#line;
        this.#line = "";
        this.#cursor = 0;
        this.#historyIndex = -1;
        return this.#submit(line);
      }
      if (code === 0x7f || code === 0x08) return this.#erase(this.#cursor - 1);
      if (code === 0x04) return this.#line ? this.#erase(this.#cursor) : this.#exit();
      if (code === 0x03) return this.#interrupt();
      if (code === 0x01) return this.#move(0);
      if (code === 0x05) return this.#move(this.#line.length);
      if (code === 0x15) { this.#line = this.#line.slice(this.#cursor); this.#cursor = 0; return this.#redraw(); }
      if (code === 0x0b) { this.#line = this.#line.slice(0, this.#cursor); return this.#redraw(); }
      if (code === 0x0c) { this.#output.write("\x1b[2J\x1b[H"); return this.#redraw(); }
      if (code < 0x20) return;
      this.#line = this.#line.slice(0, this.#cursor) + char + this.#line.slice(this.#cursor);
      this.#cursor += char.length;
      if (this.#cursor === this.#line.length) this.#output.write(char);
      else this.#redraw();
    }

    #escapeKey(char: string) {
      this.#escape += char;
      if (this.#escape.length === 2 && char !== "[" && char !== "O") { this.#escape = ""; return; }
      if (this.#escape.length < 3 || /^[\d;]$/.test(char)) return;
      const sequence = this.#escape;
      this.#escape = "";
      const key = sequence.slice(2);
      if (key === "A") return this.#recall(1);
      if (key === "B") return this.#recall(-1);
      if (key === "C") return this.#move(this.#cursor + 1);
      if (key === "D") return this.#move(this.#cursor - 1);
      if (key === "H" || key === "1~") return this.#move(0);
      if (key === "F" || key === "4~") return this.#move(this.#line.length);
      if (key === "3~") return this.#erase(this.#cursor);
    }

    #erase(at: number) {
      if (at < 0 || at >= this.#line.length) return;
      this.#line = this.#line.slice(0, at) + this.#line.slice(at + 1);
      this.#cursor = at;
      this.#redraw();
    }

    #move(cursor: number) {
      this.#cursor = Math.max(0, Math.min(this.#line.length, cursor));
      this.#redraw();
    }

    #recall(step: number) {
      const index = Math.max(-1, Math.min(this.history.length - 1, this.#historyIndex + step));
      if (index === this.#historyIndex) return;
      this.#historyIndex = index;
      this.#line = index < 0 ? "" : this.history[this.history.length - 1 - index];
      this.#cursor = this.#line.length;
      this.#redraw();
    }

    #redraw() {
      const prompt = this.#pending.length ? "... " : this.#prompt;
      const back = this.#line.length - this.#cursor;
      this.#output.write(ERASE_LINE + prompt + this.#line + (back ? `\x1b[${back}D` : ""));
    }

    #interrupt() {
      // Like Bun, Ctrl+C stops waiting for a running evaluation and returns to the prompt.
      if (this.#cancel) return this.#cancel();
      if (this.#line || this.#pending.length) {
        this.#line = "";
        this.#cursor = 0;
        this.#pending = [];
        this.#interrupted = false;
        this.#output.write("\r\n");
        return this.displayPrompt();
      }
      if (this.#interrupted) return this.#exit();
      this.#interrupted = true;
      this.#output.write("\r\n(To exit, press Ctrl+C again or Ctrl+D or type .exit)\r\n");
      this.displayPrompt();
    }

    #exit() {
      this.#output.write("\r\n");
      this.close();
    }

    #submit(line: string) {
      if (this.#closed) return;
      this.#interrupted = false;
      if (line.trim() && this.history.at(-1) !== line) this.history.push(line);
      this.#queue = this.#queue.then(async () => {
        if (this.#closed) return;
        await this.#run(line);
      }).catch(error => this.#print(error, true)).then(() => this.displayPrompt());
    }

    async #run(line: string) {
      const trimmed = line.trim();
      if (!this.#pending.length && trimmed.startsWith(".")) return this.#command(trimmed);
      if (!this.#pending.length && !trimmed) return;
      const source = this.#pending.concat(line).join("\n");
      let code: string;
      try {
        code = this.#transpiler.transformSync(source);
      } catch (error) {
        if (incomplete(error, source)) { this.#pending.push(line); return; }
        this.#pending = [];
        return this.#print(error, true);
      }
      this.#pending = [];
      try {
        let result: unknown = internal.native.evalScript(code, "[repl]");
        // The async IIFE for top-level await; a promise value itself arrives wrapped in { value }.
        if (isThenable(result)) {
          const cancelled = Symbol("cancelled");
          const stop = new Promise<symbol>(resolve => { this.#cancel = () => resolve(cancelled); });
          try {
            result = await Promise.race([result, stop]);
          } finally {
            this.#cancel = undefined;
          }
          if (result === cancelled) { this.#output.write(this.#terminal ? "\r\n" : "\n"); return; }
        }
        if (result && typeof result === "object" && Object.hasOwn(result, "value")) result = Reflect.get(result, "value");
        if (result !== undefined) Reflect.set(globalThis, "_", result);
        this.#print(result, false);
      } catch (error) {
        Reflect.set(globalThis, "_error", error);
        this.#print(error, true);
      }
    }

    #command(text: string) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const command = this.commands[name] ?? Object.entries(this.commands).find(([key]) => name && key.startsWith(name))?.[1];
      if (!command) { this.#output.write(`Invalid REPL keyword\r\n`); return; }
      try {
        command.action.call(this, rest.join(" "));
      } catch (error) {
        this.#print(error, true);
      }
    }

    #print(value: unknown, error: boolean) {
      const text = error && value instanceof Error ? (value.stack || String(value)) : Bun.inspect(value, { colors: this.#colors });
      const output = error ? process.stderr : this.#output;
      output.write(this.#terminal ? text.replaceAll("\n", "\r\n") + "\r\n" : text + "\n");
    }
  }

  // Unterminated input continues on a "..." line: Bun reports "Unexpected end of file", and an
  // open template literal as "Unterminated string literal", which is told apart from a broken
  // '...' or "..." here. Other syntax errors (an unterminated regex, say) are reported.
  function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" || typeof value === "function") && value !== null && typeof Reflect.get(value, "then") === "function";
  }
  function incomplete(error: unknown, source: string): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (/end of file|to terminate multi-line comment/i.test(message)) return true;
    return /Unterminated string literal/.test(message) && unclosed(source);
  }
  function unclosed(source: string): boolean {
    const stack: string[] = [];
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (stack.at(-1) === "`") {
        if (char === "\\") index++;
        else if (char === "`") stack.pop();
        else if (char === "$" && source[index + 1] === "{") { stack.push("${"); index++; }
        continue;
      }
      if (char === "/" && source[index + 1] === "/") { index = source.indexOf("\n", index); if (index < 0) return false; continue; }
      if (char === "/" && source[index + 1] === "*") { index = source.indexOf("*/", index + 2); if (index < 0) return true; index++; continue; }
      if (char === "'" || char === "\"") { index = closingQuote(source, index, char); if (index < 0) return false; continue; }
      if (char === "`" || char === "(" || char === "[" || char === "{") stack.push(char);
      else if (char === "}" && stack.at(-1) === "${") stack.pop();
      else if (pairs[char]) { if (stack.pop() !== pairs[char]) return false; }
    }
    return stack.length > 0;
  }
  // An unterminated '...' or "..." is a real error, not more input.
  function closingQuote(source: string, start: number, quote: string): number {
    for (let index = start + 1; index < source.length; index++) {
      if (source[index] === "\\") index++;
      else if (source[index] === quote) return index;
      else if (source[index] === "\n") return -1;
    }
    return -1;
  }

  const builtinCommands: Record<string, Command> = {
    help: {
      help: "Print this help message",
      action() {
        const lines = Object.entries(this.commands).map(([name, command]) => `  .${name.padEnd(11)} ${command.help}`);
        process.stdout.write(lines.concat("", "Press Ctrl+C to abort the current expression, Ctrl+D to exit.", "").join("\r\n"));
      },
    },
    exit: { help: "Exit the REPL", action() { this.close(); } },
    clear: { help: "Clear the screen", action() { process.stdout.write("\x1b[2J\x1b[H"); } },
    break: { help: "Cancel current input", action() { this.clearBufferedCommand(); } },
    history: {
      help: "Show command history",
      action() { process.stdout.write(this.history.map((line, index) => `${index + 1}  ${line}\r\n`).join("")); },
    },
    load: {
      help: "Load a file into the REPL session",
      action(file) {
        try {
          const source = internal.builtin("node:fs").readFileSync(file).toString();
          for (const line of source.split("\n")) this.history.push(line);
          internal.native.evalScript(new Bun.Transpiler({ loader: "tsx", replMode: true }).transformSync(source), file);
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\r\n`);
        }
      },
    },
    save: {
      help: "Save REPL history to a file",
      action(file) {
        internal.builtin("node:fs").writeFileSync(file, new TextEncoder().encode(this.history.join("\n") + "\n"));
        process.stdout.write(`Session saved to: ${file}\r\n`);
      },
    },
  };

  function start(options?: string | Options) {
    return new REPLServer(typeof options === "string" ? { prompt: options } : options ?? {});
  }

  return { start, REPLServer, REPL_MODE_SLOPPY: Symbol("repl-sloppy"), REPL_MODE_STRICT: Symbol("repl-strict") };
})
