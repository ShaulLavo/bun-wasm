// A tiny shell for the xterm terminal: line editing, history, builtins and `bun …`.

import type { Terminal } from "@xterm/xterm";
import { basename, dirname, normalize } from "./fs";
import type { RuntimeFilesystem } from "@bun-wasm/runtime";
import { HOME } from "./examples";

export interface Output {
  out(data: string | Uint8Array): void;
  err(data: string | Uint8Array): void;
}

export interface ShellHost {
  fs: RuntimeFilesystem;
  /** Runs bun.wasm with `args` (without the leading "bun"). Resolves to the exit code. */
  runBun(args: string[], cwd: string, io: Output): Promise<number>;
  /** Stops the running bun.wasm, if any. */
  kill(): void;
  /** The filesystem changed outside the editor. */
  changed(): void | Promise<void>;
  /** Open a file in the editor. */
  open(path: string): void | Promise<void>;
  info(): string[];
}

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const COMMANDS = ["bun", "bunx", "ls", "cat", "echo", "cd", "pwd", "mkdir", "rm", "mv", "touch", "edit", "clear", "history", "help"];

interface Token {
  text: string;
  op?: ">" | ">>" | "&&" | ";";
}

/** Split a command line into words and operators. Supports '…', "…", backslash escapes and ~. */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ text: word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1);
      const stop = end === -1 ? line.length : end;
      let chunk = line.slice(i + 1, stop);
      if (ch === '"') chunk = chunk.replace(/\\(["\\$`])/g, "$1");
      word += chunk;
      inWord = true;
      i = stop;
    } else if (ch === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (ch === " " || ch === "\t") {
      flush();
    } else if (ch === ">") {
      flush();
      const append = line[i + 1] === ">";
      if (append) i++;
      tokens.push({ text: append ? ">>" : ">", op: append ? ">>" : ">" });
    } else if (ch === ";") {
      flush();
      tokens.push({ text: ";", op: ";" });
    } else if (ch === "&" && line[i + 1] === "&") {
      flush();
      i++;
      tokens.push({ text: "&&", op: "&&" });
    } else if (ch === "~" && !inWord && (line[i + 1] === undefined || line[i + 1] === "/" || line[i + 1] === " ")) {
      word += HOME;
      inWord = true;
    } else {
      word += ch;
      inWord = true;
    }
  }
  flush();
  return tokens;
}

export class Shell {
  private line = "";
  private cursor = 0;
  /** Row of the terminal cursor relative to the prompt's first row. */
  private row = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = "";
  private busy = false;
  private lastExit = 0;
  private atLineStart = true;
  private completionRevision = 0;
  cwd = HOME;

  constructor(
    private term: Terminal,
    private host: ShellHost,
  ) {
    term.onData((data) => this.input(data));
  }

  get running(): boolean {
    return this.busy;
  }

  start(banner: string[]): void {
    for (const line of banner) this.term.writeln(line);
    this.prompt();
  }

  /** Type `command` at the prompt and run it, as if the user had entered it. */
  async submit(command: string): Promise<void> {
    if (this.busy) return;
    this.line = command;
    this.cursor = command.length;
    this.render();
    await this.enter();
  }

  private write(data: string | Uint8Array): void {
    if (data.length === 0) return;
    this.term.write(data);
    const last = typeof data === "string" ? data.charCodeAt(data.length - 1) : data[data.length - 1];
    this.atLineStart = last === 10;
  }

  private promptText(): { text: string; width: number } {
    const dir = this.cwd === HOME ? "~" : this.cwd.startsWith(`${HOME}/`) ? `~${this.cwd.slice(HOME.length)}` : this.cwd;
    const status = this.lastExit === 0 ? "" : `${RED}[${this.lastExit}]${RESET} `;
    const statusWidth = this.lastExit === 0 ? 0 : String(this.lastExit).length + 3;
    return {
      text: `${status}${GREEN}user@bun${RESET}:${BLUE}${dir}${RESET}$ `,
      width: statusWidth + "user@bun".length + 1 + dir.length + 2,
    };
  }

  private prompt(): void {
    if (!this.atLineStart) this.term.write(`${DIM}⏎${RESET}\r\n`);
    this.line = "";
    this.cursor = 0;
    this.row = 0;
    this.term.write(this.promptText().text);
    this.atLineStart = false;
  }

  /** Redraw the prompt and input line, handling lines that wrap. */
  private render(): void {
    const cols = this.term.cols;
    const { text, width } = this.promptText();
    let seq = this.row > 0 ? `\x1b[${this.row}A\r` : "\r";
    seq += `${text}${this.line}\x1b[J`;
    const end = width + this.line.length;
    const endRow = end > 0 && end % cols === 0 ? end / cols - 1 : Math.floor(end / cols);
    const target = width + this.cursor;
    let targetRow = Math.floor(target / cols);
    if (target === end) targetRow = endRow;
    const up = endRow - targetRow;
    if (up > 0) seq += `\x1b[${up}A`;
    if (target !== end || end % cols !== 0) {
      seq += "\r";
      const col = target % cols;
      if (col > 0) seq += `\x1b[${col}C`;
    }
    this.row = targetRow;
    this.term.write(seq);
  }

  private input(data: string): void {
    this.completionRevision++;
    if (this.busy) {
      if (data.includes("\x03")) this.host.kill();
      return;
    }
    let i = 0;
    while (i < data.length) {
      const rest = data.slice(i);
      const esc = /^\x1b(?:\[([0-9;]*)([A-Za-z~])|O([A-Za-z]))/.exec(rest);
      if (esc) {
        this.escape(esc[1] ?? "", esc[2] ?? esc[3] ?? "");
        i += esc[0].length;
        continue;
      }
      const ch = data[i]!;
      i++;
      if (ch === "\r" || ch === "\n") {
        if (ch === "\n" && data[i - 2] === "\r") continue;
        const remaining = data.slice(i);
        void this.enter().then(() => {
          if (remaining) this.input(remaining);
        });
        return;
      }
      this.key(ch);
    }
  }

  private escape(params: string, final: string): void {
    switch (final) {
      case "A":
        return this.historyMove(-1);
      case "B":
        return this.historyMove(1);
      case "C":
        if (this.cursor < this.line.length) this.cursor++;
        return this.render();
      case "D":
        if (this.cursor > 0) this.cursor--;
        return this.render();
      case "H":
        this.cursor = 0;
        return this.render();
      case "F":
        this.cursor = this.line.length;
        return this.render();
      case "~":
        if (params === "3" && this.cursor < this.line.length) {
          this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        } else if (params === "1" || params === "7") this.cursor = 0;
        else if (params === "4" || params === "8") this.cursor = this.line.length;
        return this.render();
    }
  }

  private key(ch: string): void {
    switch (ch) {
      case "\x7f":
      case "\b":
        if (this.cursor === 0) return;
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor--;
        return this.render();
      case "\x03":
        this.term.write("^C\r\n");
        this.atLineStart = true;
        this.lastExit = 130;
        return this.prompt();
      case "\x0c":
        this.term.clear();
        this.row = 0;
        this.term.write("\x1b[H\x1b[2J");
        return this.render();
      case "\x15":
        this.line = this.line.slice(this.cursor);
        this.cursor = 0;
        return this.render();
      case "\x0b":
        this.line = this.line.slice(0, this.cursor);
        return this.render();
      case "\x01":
        this.cursor = 0;
        return this.render();
      case "\x05":
        this.cursor = this.line.length;
        return this.render();
      case "\t":
        void this.complete().catch((error) => {
          this.write(`\r\n${RED}${String(error)}${RESET}\r\n`);
          if (!this.busy) {
            this.row = 0;
            this.render();
          }
        });
        return;
    }
    if (ch < " ") return;
    const atEnd = this.cursor === this.line.length;
    this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
    this.cursor += ch.length;
    if (atEnd && (this.promptText().width + this.line.length) % this.term.cols !== 0) {
      this.term.write(ch);
      this.row = Math.floor((this.promptText().width + this.cursor) / this.term.cols);
    } else {
      this.render();
    }
  }

  private historyMove(delta: number): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === this.history.length) this.draft = this.line;
    const next = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    if (next === this.historyIndex) return;
    this.historyIndex = next;
    this.line = next === this.history.length ? this.draft : this.history[next]!;
    this.cursor = this.line.length;
    this.render();
  }

  private async complete(): Promise<void> {
    const revision = ++this.completionRevision;
    const line = this.line;
    const cursor = this.cursor;
    const cwd = this.cwd;
    const before = line.slice(0, cursor);
    const match = /(\S*)$/.exec(before)!;
    const partial = match[1]!;
    const first = before.trimStart() === partial;
    let candidates: string[];
    let prefix = "";
    if (first) {
      candidates = COMMANDS.filter((c) => c.startsWith(partial)).map((c) => `${c} `);
    } else {
      const slash = partial.lastIndexOf("/");
      prefix = slash >= 0 ? partial.slice(0, slash + 1) : "";
      const dir = await this.host.fs.lookup(normalize(prefix || ".", cwd));
      if (dir?.kind !== "dir") return;
      if (this.busy || revision !== this.completionRevision || this.line !== line || this.cursor !== cursor || this.cwd !== cwd) return;
      const stem = partial.slice(prefix.length);
      candidates = Array.from(dir.children, ([name, node]) => (node.kind === "dir" ? `${name}/` : `${name} `)).filter((n) => n.startsWith(stem));
    }
    if (candidates.length === 0) return;
    const insert = (text: string) => {
      this.line = before.slice(0, before.length - partial.length) + text + this.line.slice(this.cursor);
      this.cursor = before.length - partial.length + text.length;
      this.render();
    };
    if (candidates.length === 1) return insert(prefix + candidates[0]!);
    let common = candidates[0]!.trimEnd();
    for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
    if (prefix + common !== partial) return insert(prefix + common);
    this.term.write(`\r\n${candidates.map((c) => c.trimEnd()).join("  ")}\r\n`);
    this.row = 0;
    this.render();
  }

  private async enter(): Promise<void> {
    this.completionRevision++;
    const line = this.line;
    this.cursor = this.line.length;
    this.render();
    this.term.write("\r\n");
    this.atLineStart = true;
    if (line.trim()) {
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
    }
    this.historyIndex = this.history.length;
    this.draft = "";
    this.busy = true;
    try {
      await this.execute(line);
    } catch (err) {
      this.write(`${RED}${String(err)}${RESET}\r\n`);
      this.lastExit = 1;
    }
    this.busy = false;
    this.prompt();
  }

  private async execute(line: string): Promise<void> {
    const tokens = tokenize(line);
    let group: Token[] = [];
    const groups: { tokens: Token[]; then: "&&" | ";" }[] = [];
    for (const t of tokens) {
      if (t.op === "&&" || t.op === ";") {
        groups.push({ tokens: group, then: t.op });
        group = [];
      } else group.push(t);
    }
    groups.push({ tokens: group, then: ";" });
    let previous: { then: "&&" | ";" } | null = null;
    for (const g of groups) {
      if (previous?.then === "&&" && this.lastExit !== 0) break;
      previous = g;
      if (g.tokens.length === 0) continue;
      this.lastExit = await this.command(g.tokens);
    }
  }

  private async command(tokens: Token[]): Promise<number> {
    const args: string[] = [];
    let redirect: { path: string; append: boolean } | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.op === ">" || t.op === ">>") {
        const target = tokens[++i];
        if (!target || target.op) {
          this.write(`${RED}syntax error: expected a file after ${t.op}${RESET}\r\n`);
          return 2;
        }
        redirect = { path: normalize(target.text, this.cwd), append: t.op === ">>" };
      } else args.push(t.text);
    }
    if (args.length === 0) return 0;
    const captured: Uint8Array[] = [];
    const encoder = new TextEncoder();
    const io: Output = {
      out: (data) => {
        if (redirect) captured.push(typeof data === "string" ? encoder.encode(data.replace(/\r\n/g, "\n")) : data);
        else this.write(data);
      },
      err: (data) => this.write(data),
    };
    const code = await this.dispatch(args[0]!, args.slice(1), io);
    if (redirect) {
      const total = captured.reduce((n, c) => n + c.length, 0);
      const data = new Uint8Array(total);
      let at = 0;
      for (const c of captured) {
        data.set(c, at);
        at += c.length;
      }
      try {
        await this.host.fs.writeFile(redirect.path, data, redirect.append);
        await this.host.changed();
      } catch (err) {
        this.write(`${RED}${String(err)}${RESET}\r\n`);
        return 1;
      }
    }
    return code;
  }

  private async dispatch(name: string, args: string[], io: Output): Promise<number> {
    const fs = this.host.fs;
    const fail = (msg: string) => {
      io.err(`${name}: ${msg}\r\n`);
      return 1;
    };
    const path = (p: string) => normalize(p, this.cwd);
    switch (name) {
      case "bun":
        return this.host.runBun(args, this.cwd, io);
      case "bunx":
        return this.host.runBun(["x"].concat(args), this.cwd, io);
      case "help":
        io.out(
          [
            `${BOLD}Bun in your browser${RESET}: bun.wasm runs in a Web Worker against an in-memory filesystem.`,
            "",
            `  ${GREEN}bun run <file>${RESET}      run a TypeScript/JavaScript file`,
            `  ${GREEN}bun -e '<code>'${RESET}     evaluate code`,
            `  ${GREEN}bun test${RESET}            run *.test.ts files with bun:test`,
            `  ${GREEN}bun build <entry> --outdir out [--minify]${RESET}   bundle with Bun's bundler`,
            `  ${GREEN}bun --version${RESET}       print the version`,
            `  ls [-a] [dir]  cat <file>  echo <text> [> file]  cd  pwd  mkdir [-p]  rm [-r]  mv  touch`,
            `  edit <file>    open a file in the editor`,
            `  clear  history  help`,
            "",
            `  Keys: ↑/↓ history, Tab completes, Ctrl-C stops a running program, Ctrl-L clears.`,
            `  Editor: Ctrl/Cmd-S saves, Ctrl/Cmd-Enter runs the current file.`,
            ...this.host.info().map((l) => `  ${DIM}${l}${RESET}`),
            "",
          ].join("\r\n"),
        );
        return 0;
      case "clear":
        this.term.clear();
        this.term.write("\x1b[H\x1b[2J");
        return 0;
      case "history":
        io.out(this.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}\r\n`).join(""));
        return 0;
      case "pwd":
        io.out(`${this.cwd}\r\n`);
        return 0;
      case "echo": {
        const newline = args[0] !== "-n";
        io.out(`${(newline ? args : args.slice(1)).join(" ")}${newline ? "\r\n" : ""}`);
        return 0;
      }
      case "cd": {
        const target = path(args[0] ?? HOME);
        const node = await fs.lookup(target);
        if (!node) return fail(`${args[0]}: no such file or directory`);
        if (node.kind !== "dir") return fail(`${args[0]}: not a directory`);
        this.cwd = target;
        return 0;
      }
      case "ls": {
        const all = args.includes("-a") || args.includes("-la") || args.includes("-al");
        const targets = args.filter((a) => !a.startsWith("-"));
        if (targets.length === 0) targets.push(".");
        let code = 0;
        for (const t of targets) {
          const node = await fs.lookup(path(t));
          if (!node) {
            code = fail(`${t}: no such file or directory`);
            continue;
          }
          if (targets.length > 1) io.out(`${t}:\r\n`);
          if (node.kind === "file") {
            io.out(`${t}\r\n`);
            continue;
          }
          const names = Array.from(node.children.keys()).sort().filter((n) => all || !n.startsWith("."));
          if (all) names.unshift(".", "..");
          const items = names.map((n) => {
            const child = n === "." || n === ".." ? node : node.children.get(n)!;
            return child.kind === "dir" ? `${BLUE}${BOLD}${n}/${RESET}` : n;
          });
          if (items.length) io.out(`${items.join("  ")}\r\n`);
        }
        return code;
      }
      case "cat": {
        let code = 0;
        for (const a of args) {
          const node = await fs.lookup(path(a));
          if (!node) code = fail(`${a}: no such file or directory`);
          else if (node.kind === "dir") code = fail(`${a}: is a directory`);
          else io.out(await fs.readFile(path(a)) ?? new Uint8Array());
        }
        return code;
      }
      case "touch":
        for (const a of args) if (!await fs.lookup(path(a))) await fs.writeFile(path(a), "");
        await this.host.changed();
        return 0;
      case "mkdir": {
        const parents = args.includes("-p");
        for (const a of args.filter((x) => x !== "-p")) {
          const p = path(a);
          if (await fs.lookup(p)) {
            if (!parents) return fail(`${a}: file exists`);
            continue;
          }
          if (!parents && (await fs.lookup(dirname(p)))?.kind !== "dir") return fail(`${a}: no such file or directory`);
          await fs.mkdirp(p);
        }
        await this.host.changed();
        return 0;
      }
      case "rm": {
        const recursive = args.some((a) => /^-[a-z]*r/.test(a));
        let code = 0;
        for (const a of args.filter((x) => !x.startsWith("-"))) {
          const p = path(a);
          const node = await fs.lookup(p);
          if (!node) code = fail(`${a}: no such file or directory`);
          else if (node.kind === "dir" && !recursive) code = fail(`${a}: is a directory (use rm -r)`);
          else if (p === "/") code = fail("refusing to remove /");
          else await fs.remove(p);
        }
        await this.host.changed();
        return code;
      }
      case "mv": {
        if (args.length !== 2) return fail("usage: mv <from> <to>");
        const from = path(args[0]!);
        let to = path(args[1]!);
        const node = await fs.lookup(from);
        if (!node) return fail(`${args[0]}: no such file or directory`);
        if ((await fs.lookup(to))?.kind === "dir") to = normalize(basename(from), to);
        const parent = await fs.lookup(dirname(to));
        if (parent?.kind !== "dir") return fail(`${args[1]}: no such directory`);
        await fs.move(from, to);
        await this.host.changed();
        return 0;
      }
      case "edit": {
        if (!args[0]) return fail("usage: edit <file>");
        const p = path(args[0]);
        const node = await fs.lookup(p);
        if (node?.kind === "dir") return fail(`${args[0]}: is a directory`);
        if (!node) {
          await fs.writeFile(p, "");
          await this.host.changed();
        }
        await this.host.open(p);
        return 0;
      }
      default:
        io.err(`${name}: command not found. Try ${GREEN}help${RESET}.\r\n`);
        return 127;
    }
  }
}

