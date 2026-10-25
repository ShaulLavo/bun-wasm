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

  function out(args: readonly unknown[]) {
    emit(native.writeStdout, inspector().formatArgs(args));
  }

  function err(args: readonly unknown[]) {
    emit(native.writeStderr, inspector().formatArgs(args));
  }

  function formatDuration(ms: number) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${ms.toFixed(2)}ms`;
  }

  const console = {
    log: (...args: unknown[]) => out(args),
    info: (...args: unknown[]) => out(args),
    debug: (...args: unknown[]) => out(args),
    warn: (...args: unknown[]) => err(args),
    error: (...args: unknown[]) => err(args),
    trace(...args: unknown[]) {
      const holder = new Error();
      const stack = (holder.stack || "").split("\n").slice(1).join("\n");
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
      emit(native.writeStdout, inspector().bunInspect(value, options));
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
      emit(native.writeStdout, renderTable(data, columns));
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

  function cellText(value: unknown) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return inspector().bunInspect(value, { depth: 0, compact: true }).replace(/\s*\n\s*/g, " ");
  }

  function rowsOf(data: object): [unknown, unknown][] {
    if (data instanceof Map) return Array.from(data, ([k, v]) => [k, v]);
    if (data instanceof Set) return Array.from(data, (v, i) => [i, v]);
    return Object.keys(data).map((k) => [Array.isArray(data) ? Number(k) : k, (data as Record<string, unknown>)[k]]);
  }

  function renderTable(data: object, columns?: readonly unknown[]) {
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
    const header = [""].concat(cols, hasValues ? ["Values"] : []);
    const body = rows.map(([index, value]) => {
      const isObj = value !== null && typeof value === "object";
      const cells = cols.map((c) => (isObj && c in value ? cellText((value as Record<string, unknown>)[c]) : ""));
      return [String(index)].concat(cells, hasValues ? [isObj ? "" : cellText(value)] : []);
    });
    const width = (s: string) => (globalThis.Bun ? Bun.stringWidth(s) : s.length);
    const widths = header.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i]))) + 2);
    const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w)).join(m) + r;
    const fmtRow = (cells: string[]) => "│" + cells.map((c, i) => center(c, widths[i], width)).join("│") + "│";
    const lines = [line("┌", "┬", "┐"), fmtRow(header), line("├", "┼", "┤")]
      .concat(body.map(fmtRow))
      .concat([line("└", "┴", "┘")]);
    return lines.join("\n");
  }

  // Bun left-aligns cells after one space of padding.
  function center(text: string, w: number, width: (text: string) => number) {
    return " " + text + " ".repeat(w - width(text) - 1);
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
  for (const name of ["stdout", "stderr"]) {
    Object.defineProperty(console, "_" + name, {
      value: globalThis.process[name as "stdout" | "stderr"], writable: true, configurable: true,
    });
  }
  Object.defineProperty(console, Symbol.toStringTag, { value: "console", configurable: true });
  return console;
})
