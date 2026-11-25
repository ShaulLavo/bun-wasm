// The `console` global. Formatting comes from inspect.js (a port of Bun's
// console formatter); this file only routes output and keeps state
// (groups, counters, timers).
(function (internal: BunWasm.ConsoleInternal) {
  "use strict";
  const native = internal.native;

  let groupIndent = "";
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();

  function inspector() {
    return internal.require("inspect");
  }

  function emit(write: (text: string) => void, text: string) {
    const indented = groupIndent ? text.replace(/^/gm, groupIndent) : text;
    write(indented + "\n");
  }

  // Bun writes a group's indentation before the message only; the formatter indents the lines
  // it breaks itself, so a line break inside a string stays at the start of the line.
  function emitFormatted(write: (text: string) => void, text: string) {
    write(groupIndent + text + "\n");
  }

  // Bun colours log, info and debug when stdout gets colours, and warn and error when stderr does.
  function colors() {
    return internal.require("pretty_output");
  }

  function formatOptions(level: "log" | "warn" | "error", enabled: boolean) {
    return { indent: groupIndent.length / 2, level, colors: enabled };
  }

  function out(args: readonly unknown[]) {
    emitFormatted(native.writeStdout, inspector().formatArgs(args, formatOptions("log", colors().stdout)));
  }

  // ConsoleObject.rs format2: with colours, console.error wraps its line in red unless it
  // prints a single value that is not a string.
  function err(args: readonly unknown[], level: "warn" | "error" = "error") {
    const enabled = colors().stderr;
    const text = inspector().formatArgs(args, formatOptions(level, enabled));
    const red = enabled && level === "error" && (args.length > 1 || typeof args[0] === "string");
    emitFormatted(native.writeStderr, red ? "\u001b[0m\u001b[31m" + text + "\u001b[0m" : text);
  }

  // console.dir reads only `depth` and `colors` (ConsoleObject.rs, message_type == Dir). A depth
  // is clamped to 0 or above, then cut to 16 bits; null is the largest depth.
  function dirOptions(options: BunWasm.ConsoleInspectOptions | undefined): BunWasm.ConsoleInspectOptions {
    const result: BunWasm.ConsoleInspectOptions = { depth: 2 };
    if (options === null || typeof options !== "object") return result;
    const depth: unknown = options.depth;
    if (depth === null) {
      result.depth = 65535;
    } else if (typeof depth === "number" || typeof depth === "bigint") {
      const n = Number(depth);
      const int32 = Number.isNaN(n) ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(n)));
      result.depth = Math.max(int32, 0) & 0xffff;
    }
    if (typeof options.colors === "boolean") result.colors = options.colors;
    return result;
  }

  function formatDuration(ms: number) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${ms.toFixed(2)}ms`;
  }

  const console = {
    log: (...args: unknown[]) => out(args),
    info: (...args: unknown[]) => out(args),
    debug: (...args: unknown[]) => out(args),
    warn: (...args: unknown[]) => err(args, "warn"),
    error: (...args: unknown[]) => err(args),
    trace(...args: unknown[]) {
      const holder = new Error();
      // Drop the "Error" header and this frame, where the engine shows the runtime's frames.
      const lines = (holder.stack || "").split("\n");
      if (lines[0] === "Error") lines.shift();
      if (lines[0]?.includes("bun-wasm:")) lines.shift();
      const stack = lines.join("\n");
      const message = args.length ? inspector().formatArgs(args) : "";
      emit(native.writeStderr, `Trace${message ? ": " + message : ""}\n${stack.replace(/\n$/, "")}`);
    },
    assert(condition: unknown, ...args: unknown[]) {
      if (condition) return;
      if (args.length === 0) {
        err(["Assertion failed"]);
        return;
      }
      if (typeof args[0] === "string") {
        err(([`Assertion failed: ${args[0]}`] as unknown[]).concat(args.slice(1)));
        return;
      }
      err((["Assertion failed:"] as unknown[]).concat(args));
    },
    dir(value: unknown, options?: BunWasm.ConsoleInspectOptions) {
      const { depth, colors: enabled = colors().stdout } = dirOptions(options);
      emitFormatted(native.writeStdout, inspector().formatArgs([value], { depth, colors: enabled, indent: groupIndent.length / 2 }));
    },
    dirxml: (...args: unknown[]) => out(args),
    count(label: unknown = "default") {
      const key = String(label);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      out([`${key}: ${n}`]);
    },
    countReset(label: unknown = "default") {
      counts.set(String(label), 0);
    },
    group(...args: unknown[]) {
      if (args.length) out(args);
      groupIndent += "  ";
    },
    groupCollapsed(...args: unknown[]) {
      console.group(...args);
    },
    groupEnd() {
      groupIndent = groupIndent.slice(2);
    },
    time(label: unknown = "default") {
      timers.set(String(label), native.now());
    },
    timeEnd(label: unknown = "default") {
      const key = String(label);
      const start = timers.get(key);
      if (start === undefined) return;
      timers.delete(key);
      out([`[${formatDuration(native.now() - start)}] ${key}`]);
    },
    timeLog(label: unknown = "default", ...args: unknown[]) {
      const key = String(label);
      const start = timers.get(key);
      if (start === undefined) return;
      out(([`[${formatDuration(native.now() - start)}] ${key}`] as unknown[]).concat(args));
    },
    table(data: unknown, columns?: readonly unknown[]) {
      if (data === null || typeof data !== "object") {
        out([data]);
        return;
      }
      emit(native.writeStdout, renderTable(data, columns, colors().stdout));
    },
    clear() {},
    profile() {},
    profileEnd() {},
    timeStamp() {},
    write(...args: unknown[]) {
      for (const a of args) native.writeStdout(typeof a === "string" ? a : internal.toUint8(a));
    },
  };

  // --- console.table: Bun's box-drawing layout ------------------------------

  function cellText(value: unknown, enabled: boolean) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return inspector().bunInspect(value, { depth: 0, compact: true, colors: enabled }).replace(/\s*\n\s*/g, " ");
  }

  // Cell widths leave out colour escapes.
  function visibleWidth(text: string) {
    // oxlint-disable-next-line no-control-regex -- Strips ANSI colour sequences.
    return globalThis.Bun ? Bun.stringWidth(text) : text.replace(/\u001b\[[0-9;]*m/g, "").length;
  }

  function rowsOf(data: object): [unknown, unknown][] {
    if (data instanceof Map) return Array.from(data, ([k, v]) => [k, v]);
    if (data instanceof Set) return Array.from(data, (v, i) => [i, v]);
    return Object.keys(data).map((k) => [Array.isArray(data) ? Number(k) : k, (data as Record<string, unknown>)[k]]);
  }

  function renderTable(data: object, columns: readonly unknown[] | undefined, enabled: boolean) {
    const rows = rowsOf(data);
    const keys: string[] = [];
    let hasValues = false;
    for (const [, value] of rows) {
      if (value === null || typeof value !== "object") {
        hasValues = true;
        continue;
      }
      for (const k of Object.keys(value)) if (!keys.includes(k)) keys.push(k);
    }
    const cols = Array.isArray(columns) ? columns.map(String) : keys;
    const header = [" "].concat(cols, hasValues ? ["Values"] : []);
    const body = rows.map(([index, value]) => {
      const isObj = value !== null && typeof value === "object";
      const cells = cols.map((c) => (isObj && c in value ? cellText((value as Record<string, unknown>)[c], enabled) : ""));
      return [String(index)].concat(cells, hasValues ? [isObj ? "" : cellText(value, enabled)] : []);
    });
    const widths = header.map((h, i) => Math.max(visibleWidth(h), ...body.map((r) => visibleWidth(r[i]))) + 2);
    const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w)).join(m) + r;
    const fmtRow = (cells: string[], bold = false) => "│" + cells.map((c, i) => center(c, widths[i], bold && enabled)).join("│") + "│";
    const lines = [line("┌", "┬", "┐"), fmtRow(header, true), line("├", "┼", "┤")]
      .concat(body.map((row) => fmtRow(row)))
      .concat([line("└", "┴", "┘")]);
    return lines.join("\n");
  }

  // Bun left-aligns cells after one space of padding; column names are `<r><b>name<r>`.
  function center(text: string, w: number, bold: boolean) {
    const shown = bold ? "\u001b[0m\u001b[1m" + text + "\u001b[0m" : text;
    return " " + shown + " ".repeat(w - visibleWidth(text) - 1);
  }

  for (const key of Object.keys(console)) {
    Object.defineProperty(console[key as keyof typeof console], "name", { value: key });
  }
  Object.defineProperty(console, "Console", {
    configurable: true,
    enumerable: true,
    get() {
      const Console = internal.require("bun_console_constructor")(console);
      Object.defineProperty(console, "Console", { value: Console, writable: true, configurable: true, enumerable: true });
      return Console;
    },
  });
  // Made on first use, as in Bun: reading process.stdout at startup would build both streams
  // for programs that never write through them.
  for (const name of ["stdout", "stderr"] as const) {
    const key = "_" + name;
    const settle = (value: unknown) => {
      Object.defineProperty(console, key, { value, writable: true, configurable: true });
      return value;
    };
    Object.defineProperty(console, key, { get: () => settle(globalThis.process[name]), set: settle, configurable: true });
  }
  Object.defineProperty(console, Symbol.toStringTag, { value: "console", configurable: true });
  return console;
})
