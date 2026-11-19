// process.emitWarning and the default 'warning' listener, as Bun has them at the pinned
// commit. emitWarning follows Process::emitWarning and emitWarningErrorInstance in
// src/jsc/bindings/BunProcess.cpp; the printer is createOnWarning from
// src/js/builtins/ProcessObjectInternals.ts, Bun's port of Node's
// lib/internal/process/warning.js onWarning. docs/bun-patches/process-warnings.md records
// the adaptation.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Warning = Error & { code?: unknown; detail?: unknown };
  type WarningOptions = { ctor?: unknown; code?: unknown; detail?: unknown; type?: unknown };

  // Node's addReadOnlyProcessAlias properties, which Bun seeds from these flags.
  const aliases = new Map([
    ["--no-deprecation", "noDeprecation"],
    ["--throw-deprecation", "throwDeprecation"],
    ["--trace-deprecation", "traceDeprecation"],
    ["--trace-warnings", "traceProcessWarnings"],
    ["--pending-deprecation", "pendingDeprecation"],
    ["--no-warnings", "noProcessWarnings"],
  ]);
  // --disable-warning names and codes filter the print, not the emit.
  const disabled = new Set<string>();
  let redirectPath: string | undefined;
  let defaultListener: ((warning: unknown) => void) | undefined;

  function invalidArgType(name: string, expected: string, value: unknown) {
    const message = `The "${name}" argument must be of type ${expected}. Received ${internal.describe(value)}`;
    return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function defineHidden(target: object, key: string, value: unknown) {
    Object.defineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
  }

  function createOnWarning(process: BunWasm.WarningProcess) {
    const env = process.env.NODE_REDIRECT_WARNINGS;
    const path = redirectPath ?? (typeof env === "string" && env ? env : undefined);
    const appendFileSync = path ? internal.builtin("node:fs").appendFileSync : undefined;
    let traceWarningHelperShown = false;

    function writeOut(message: string) {
      if (appendFileSync && path) {
        try {
          appendFileSync(path, message + "\n");
          return;
        } catch {
          // Like Bun, a failed write falls back to stderr for this warning only.
        }
      }
      // process.stderr per call, so a reassigned process.stderr is honored.
      process.stderr?.write(message + "\n");
    }

    return function onWarning(warning: unknown) {
      if (!(warning instanceof Error)) return;
      const { code, detail } = warning as Warning;
      const name = warning.name || "Warning";
      const isDeprecation = name === "DeprecationWarning";
      if (isDeprecation && process.noDeprecation) return;
      if (disabled.has(name) || (typeof code === "string" && code && disabled.has(code))) return;
      const trace = process.traceProcessWarnings || (isDeprecation && process.traceDeprecation);
      let message = `(node:${process.pid}) `;
      if (code) message += `[${String(code)}] `;
      // Only touch .stack when tracing: it can run a user Error.prepareStackTrace.
      if (trace && warning.stack) message += warning.stack;
      else message += typeof warning.toString === "function" ? warning.toString() : `${name}: ${warning.message}`;
      if (typeof detail === "string") message += `\n${detail}`;
      writeOut(message);
      if (trace || traceWarningHelperShown) return;
      traceWarningHelperShown = true;
      const program = internal.require("path").basename(process.argv0 || "node");
      writeOut(`(Use \`${program} --trace-warnings ...\` to show where the warning was created)`);
    };
  }

  // Seeds the read-only aliases and --disable-warning/--redirect-warnings from runtime flags.
  // A worker calls this again with the execArgv it was started with.
  function configure(process: BunWasm.WarningProcess, argv: readonly string[]) {
    for (const arg of argv) {
      if (arg.startsWith("--disable-warning=")) disabled.add(arg.slice("--disable-warning=".length));
      if (arg.startsWith("--redirect-warnings=")) redirectPath = arg.slice("--redirect-warnings=".length);
      const alias = aliases.get(arg);
      if (alias) Object.defineProperty(process, alias, { value: true, writable: false, enumerable: true, configurable: true });
      if (arg === "--no-warnings" && defaultListener) process.removeListener("warning", defaultListener);
    }
  }

  // Node registers its printer as an ordinary 'warning' listener at startup, so
  // listenerCount('warning') is 1 and removeAllListeners('warning') silences it.
  // The printer behind the listener is built on the first warning.
  function install(process: BunWasm.WarningProcess) {
    const argv = process.execArgv;
    if (process.env.NODE_NO_WARNINGS !== "1" && !argv.includes("--no-warnings")) {
      let print: ((warning: unknown) => void) | undefined;
      defaultListener = function onWarning(warning: unknown) {
        print ??= createOnWarning(process);
        print(warning);
      };
      process.on("warning", defaultListener);
    }
    configure(process, argv);
  }

  function emitWarning(process: BunWasm.WarningProcess, warning: unknown, type?: unknown, code?: unknown, ctor?: unknown) {
    let detail: unknown;
    if (type === "DeprecationWarning" && process.noDeprecation) return;
    if (type !== null && typeof type === "object" && !Array.isArray(type)) {
      const options: WarningOptions = type;
      ctor = options.ctor;
      code = options.code;
      detail = typeof options.detail === "string" ? options.detail : undefined;
      type = options.type || "Warning";
    } else if (typeof type === "function") {
      ctor = type;
      code = undefined;
      type = "Warning";
    }
    if (type === undefined) type = "Warning";
    else if (typeof type !== "string") throw invalidArgType("type", "string", type);
    if (typeof code === "function") {
      ctor = code;
      code = undefined;
    } else if (code !== undefined && typeof code !== "string") {
      throw invalidArgType("code", "string", code);
    }

    let error: Warning;
    if (typeof warning === "string") {
      error = new Error(warning || "Warning");
      defineHidden(error, "name", type);
      // Recapture after naming, so engines that fix the stack header at capture time print
      // the warning type, and the trace starts at the caller.
      if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(error, typeof ctor === "function" ? ctor : process.emitWarning);
    } else if (warning instanceof Error) {
      error = warning;
    } else {
      throw invalidArgType("warning", "string or Error", warning);
    }
    if (code !== undefined) defineHidden(error, "code", code);
    if (detail !== undefined) defineHidden(error, "detail", detail);

    if (error.name === "DeprecationWarning") {
      if (process.noDeprecation) return;
      // Thrown on a later tick, so every earlier warning is printed first.
      if (process.throwDeprecation) {
        internal.nextTick(() => { throw error; });
        return;
      }
    }
    internal.nextTick(() => process.emit("warning", error));
  }

  // bootstrap.js loads this module right after it defines the process global.
  install(internal.require("process"));
  return { configure, emitWarning };
})
