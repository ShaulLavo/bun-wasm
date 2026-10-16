// The `console` global. Formatting comes from inspect.js (a port of Bun's
// console formatter); this file only routes output and keeps state
// (groups, counters, timers).
(function (internal) {
  "use strict";
  const native = internal.native;

  let groupIndent = "";
  const counts = new Map();
  const timers = new Map();

  function inspector() {
    return internal.require("inspect");
  }

  function emit(write, text) {
    const indented = groupIndent ? text.replace(/^/gm, groupIndent) : text;
    write(indented + "\n");
  }

  function out(args) {
    emit(native.writeStdout, inspector().formatArgs(args));
  }

  function err(args) {
    emit(native.writeStderr, inspector().formatArgs(args));
  }

  function formatDuration(ms) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${ms.toFixed(2)}ms`;
  }

  const console = {
    log: (...args) => out(args),
    info: (...args) => out(args),
    debug: (...args) => out(args),
    warn: (...args) => err(args),
    error: (...args) => err(args),
    trace(...args) {
      const holder = new Error();
      const stack = (holder.stack || "").split("\n").slice(1).join("\n");
      const message = args.length ? inspector().formatArgs(args) : "";
      emit(native.writeStderr, `Trace${message ? ": " + message : ""}\n${stack.replace(/\n$/, "")}`);
    },
    assert(condition, ...args) {
      if (condition) return;
      if (args.length === 0) {
        err(["Assertion failed"]);
        return;
      }
      if (typeof args[0] === "string") {
        err([`Assertion failed: ${args[0]}`].concat(args.slice(1)));
        return;
      }
      err(["Assertion failed:"].concat(args));
    },
    dir(value, options) {
      emit(native.writeStdout, inspector().bunInspect(value, options));
    },
    dirxml: (...args) => out(args),
    count(label = "default") {
      const key = String(label);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      out([`${key}: ${n}`]);
    },
    countReset(label = "default") {
      counts.set(String(label), 0);
    },
    group(...args) {
      if (args.length) out(args);
      groupIndent += "  ";
    },
    groupCollapsed(...args) {
      console.group(...args);
    },
    groupEnd() {
      groupIndent = groupIndent.slice(2);
    },
    time(label = "default") {
      timers.set(String(label), native.now());
    },
    timeEnd(label = "default") {
      const key = String(label);
      const start = timers.get(key);
      if (start === undefined) return;
      timers.delete(key);
      out([`[${formatDuration(native.now() - start)}] ${key}`]);
    },
    timeLog(label = "default", ...args) {
      const key = String(label);
      const start = timers.get(key);
      if (start === undefined) return;
      out([`[${formatDuration(native.now() - start)}] ${key}`].concat(args));
    },
    table(data, columns) {
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
    write(...args) {
      for (const a of args) native.writeStdout(typeof a === "string" ? a : internal.toUint8(a));
    },
  };

  // --- console.table: Bun's box-drawing layout ------------------------------

  function cellText(value) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return inspector().bunInspect(value, { depth: 0, compact: true }).replace(/\s*\n\s*/g, " ");
  }

  function rowsOf(data) {
    if (data instanceof Map) return Array.from(data, ([k, v]) => [k, v]);
    if (data instanceof Set) return Array.from(data, (v, i) => [i, v]);
    return Object.keys(data).map((k) => [Array.isArray(data) ? Number(k) : k, data[k]]);
  }

  function renderTable(data, columns) {
    const rows = rowsOf(data);
    const keys = [];
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
      const cells = cols.map((c) => (isObj && c in value ? cellText(value[c]) : ""));
      return [String(index)].concat(cells, hasValues ? [isObj ? "" : cellText(value)] : []);
    });
    const width = (s) => (globalThis.Bun ? Bun.stringWidth(s) : s.length);
    const widths = header.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i]))) + 2);
    const line = (l, m, r) => l + widths.map((w) => "─".repeat(w)).join(m) + r;
    const fmtRow = (cells) => "│" + cells.map((c, i) => center(c, widths[i], width)).join("│") + "│";
    const lines = [line("┌", "┬", "┐"), fmtRow(header), line("├", "┼", "┤")]
      .concat(body.map(fmtRow))
      .concat([line("└", "┴", "┘")]);
    return lines.join("\n");
  }

  // Bun left-aligns cells after one space of padding.
  function center(text, w, width) {
    return " " + text + " ".repeat(w - width(text) - 1);
  }

  for (const key of Object.keys(console)) {
    Object.defineProperty(console[key], "name", { value: key });
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
      value: globalThis.process[name], writable: true, configurable: true,
    });
  }
  Object.defineProperty(console, Symbol.toStringTag, { value: "console", configurable: true });
  return console;
})
