// os.getPriority and os.setPriority, after Bun's os module (src/js/node/os.ts) and Node's
// lib/os.js. The guest has one process and no scheduler, so it keeps the nice value of itself
// (pid 0 or its own pid) and reports ESRCH for every other pid, as a pid that does not exist
// would.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Coded = Error & { code: string };
  const received = (value: unknown): string => (typeof value === "bigint" ? `type bigint (${value}n)` : internal.describe(value));

  function validateInt32(value: unknown, name: string, min = -2147483648, max = 2147483647): number {
    if (typeof value !== "number") {
      throw Object.assign(new TypeError(`The "${name}" argument must be of type number. Received ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" }) as Coded;
    }
    if (!Number.isInteger(value)) {
      throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${String(value)}`), { code: "ERR_OUT_OF_RANGE" });
    }
    if (value < min || value > max) {
      throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be >= ${min} && <= ${max}. Received ${String(value)}`), { code: "ERR_OUT_OF_RANGE" });
    }
    return value;
  }

  // Node's ERR_SYSTEM_ERROR: a libuv call's failure with its details under `info`.
  function systemError(syscall: string) {
    const info = { errno: -3, code: "ESRCH", message: "no such process", syscall };
    const error = new Error(`A system error occurred: ${syscall} returned ESRCH (no such process)`);
    Object.defineProperty(error, "name", { value: "SystemError", writable: true, configurable: true, enumerable: false });
    return Object.assign(error, { code: "ERR_SYSTEM_ERROR", info, errno: info.errno, syscall });
  }

  let nice = 0;
  const ownPid = (internal.require("process") as unknown as { pid: number }).pid;
  const isSelf = (pid: number) => pid === 0 || pid === ownPid;

  function getPriority(pid?: unknown): number {
    const target = pid === undefined ? 0 : validateInt32(pid, "pid");
    if (!isSelf(target)) throw systemError("uv_os_getpriority");
    return nice;
  }

  function setPriority(pid?: unknown, priority?: unknown): void {
    if (priority === undefined) {
      priority = pid;
      pid = 0;
    }
    const target = validateInt32(pid, "pid");
    const value = validateInt32(priority, "priority", -20, 19);
    if (!isSelf(target)) throw systemError("uv_os_setpriority");
    nice = value;
  }

  return { getPriority, setPriority };
})
