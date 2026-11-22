// Argument handling for process.umask and process.cpuUsage, after Bun's Process_functionUmask and
// Process_functionCpuUsage (src/jsc/bindings/BunProcess.cpp) and its validators. The mask is
// remembered here: the guest has no host umask to change.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Coded = Error & { code: string };
  const fail = <T extends Error>(error: T, code: string): T & Coded => Object.assign(error, { code });

  // Node's ERR_INVALID_ARG_TYPE description of the received value.
  function received(value: unknown): string {
    if (typeof value === "bigint") return `type bigint (${value}n)`;
    if (typeof value === "symbol") return `type symbol (${String(value)})`;
    return internal.describe(value);
  }
  const noun = (name: string) => (name.includes(".") ? "property" : "argument");

  function validateNumber(value: unknown, name: string): asserts value is number {
    if (typeof value === "number") return;
    throw fail(new TypeError(`The "${name}" ${noun(name)} must be of type number. Received ${received(value)}`), "ERR_INVALID_ARG_TYPE");
  }

  function validateUint32(value: unknown, name: string): number {
    validateNumber(value, name);
    if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
      const rule = Number.isInteger(value) ? ">= 0 && <= 4294967295" : "an integer";
      throw fail(new RangeError(`The value of "${name}" is out of range. It must be ${rule}. Received ${String(value)}`), "ERR_OUT_OF_RANGE");
    }
    return value;
  }

  // The process keeps the low nine permission bits, as the kernel does.
  let mask = 0o22;
  function umask(value: unknown): number {
    const previous = mask;
    if (value === undefined) return previous;
    let next: number;
    if (typeof value === "string") {
      // Bun's WTF::parseInteger<mode_t>(string, 8): ASCII whitespace around an optional "+" and
      // octal digits that fit in 32 bits.
      const digits = /^[\t\n\v\f\r ]*\+?([0-7]+)[\t\n\v\f\r ]*$/.exec(value)?.[1];
      next = digits === undefined ? Number.NaN : Number.parseInt(digits, 8);
      if (!(next <= 4294967295)) {
        throw fail(new TypeError(`The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received '${value}'`), "ERR_INVALID_ARG_VALUE");
      }
    } else {
      next = validateUint32(value, "mask");
    }
    mask = next & 0o777;
    return previous;
  }

  // The comparison value of process.cpuUsage(prevValue): both fields must be numbers in 0..2^53-1.
  function cpuUsage(usage: { user: number; system: number }, previous: unknown) {
    if (previous === undefined) return usage;
    if (previous === null || (typeof previous !== "object" && typeof previous !== "function")) {
      throw fail(new TypeError(`The "prevValue" argument must be of type object. Received ${received(previous)}`), "ERR_INVALID_ARG_TYPE");
    }
    const from = previous as { user?: unknown; system?: unknown };
    const user = from.user;
    validateNumber(user, "prevValue.user");
    const system = from.system;
    validateNumber(system, "prevValue.system");
    for (const [name, field] of [["prevValue.user", user], ["prevValue.system", system]] as const) {
      if (!(field >= 0 && field <= Number.MAX_SAFE_INTEGER)) {
        throw fail(new RangeError(`The property '${name}' is invalid. Received ${String(field)}`), "ERR_INVALID_ARG_VALUE");
      }
    }
    return { user: usage.user - user, system: usage.system - system };
  }

  return { umask, cpuUsage };
})
