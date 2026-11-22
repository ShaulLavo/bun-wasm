(function () {
  return function createFsOptions(native: {
    stat(path: string, link: boolean): { mode: number };
    readdir(path: string): [string, string][];
    mkdir(path: string, recursive: boolean): unknown;
    copyFile(from: string, to: string, mode: number): void;
    readlink(path: string): string;
    symlink(target: string, path: string): void;
    unlink(path: string): void;
  }, absolute: (path: string) => string, inspect: (value: unknown) => string = String) {
    const stringFlags: Record<string, number> = {
      r: 0, "r+": 2, rs: 1052672, sr: 1052672, "rs+": 1052674, "sr+": 1052674,
      w: 577, wx: 705, xw: 705, "w+": 578, "wx+": 706, "xw+": 706,
      a: 1089, ax: 1217, xa: 1217, as: 1053761, sa: 1053761, "a+": 1090, "ax+": 1218, "xa+": 1218, "as+": 1053762, "sa+": 1053762,
    };
    function flagsNumber(flags: unknown = "r"): number {
      if (typeof flags === "string" && Object.hasOwn(stringFlags, flags)) return stringFlags[flags]!;
      if (typeof flags === "number") {
        // Node's validateInt32 for a numeric flag.
        const rule = !Number.isInteger(flags) ? "an integer" : flags < -2147483648 || flags > 2147483647 ? ">= -2147483648 && <= 2147483647" : null;
        if (rule) throw Object.assign(new RangeError(`The value of "flags" is out of range. It must be ${rule}. Received ${inspect(flags)}`), { code: "ERR_OUT_OF_RANGE" });
        return flags;
      }
      throw Object.assign(new TypeError(`The argument 'flags' is invalid. Received ${inspect(flags)}`), { code: "ERR_INVALID_ARG_VALUE" });
    }

    // Node's ERR_INVALID_ARG_TYPE description of the received value.
    function received(value: unknown): string {
      if (value === null || value === undefined) return String(value);
      if (typeof value === "function") return `function ${value.name}`;
      if (typeof value === "object") return `an instance of ${value.constructor?.name || "Object"}`;
      return `type ${typeof value} (${inspect(value)})`;
    }

    // Node's parseFileMode (lib/internal/validators.js): an octal digit string or a uint32.
    function parseFileMode(value: unknown, name: string, fallback: number): number {
      let mode = value ?? fallback;
      if (typeof mode === "string") {
        if (!/^[0-7]+$/.test(mode)) {
          throw Object.assign(new TypeError(`The argument '${name}' must be a 32-bit unsigned integer or an octal string. Received ${inspect(mode)}`), { code: "ERR_INVALID_ARG_VALUE" });
        }
        mode = Number.parseInt(mode, 8);
      }
      if (typeof mode !== "number") {
        throw Object.assign(new TypeError(`The "${name}" argument must be of type number. Received ${received(mode)}`), { code: "ERR_INVALID_ARG_TYPE" });
      }
      if (!Number.isInteger(mode) || mode < 0 || mode > 4294967295) {
        const rule = Number.isInteger(mode) ? ">= 0 && <= 4294967295" : "an integer";
        throw Object.assign(new RangeError(`The value of "${name}" is out of range. It must be ${rule}. Received ${inspect(mode)}`), { code: "ERR_OUT_OF_RANGE" });
      }
      return mode;
    }

    const { Stats, BigIntStats, makeStats } = createStats();

    type CopyOptions = { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (from: string, to: string) => boolean | Promise<boolean> };
    // Bun names the destination as the path of an existing-target error, the source otherwise.
    function copyError(code: string, from: string, to: string): Error {
      const path = code === "ERR_FS_CP_EEXIST" ? to : from;
      return Object.assign(new Error(`${code}: cannot copy '${from}' to '${to}'`), { code, path, dest: to, syscall: "cp" });
    }
    function isCode(error: unknown, code: string): boolean {
      return error !== null && typeof error === "object" && "code" in error && error.code === code;
    }
    function ensureParent(dest: string): void {
      const parent = dest.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
      try {
        native.stat(parent, false);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
        native.mkdir(parent, true);
      }
    }
    // A relative link target resolved against the source link's directory, as Bun writes it.
    function linkTarget(src: string): string {
      const target = native.readlink(src);
      if (target.startsWith("/")) return target;
      const parts: string[] = [];
      for (const part of `${src.replace(/\/[^/]*$/, "")}/${target}`.split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
      }
      return `/${parts.join("/")}`;
    }
    // Bun and Node copy a symlink as a symlink (cp's `dereference` is false by default).
    function copyLink(from: string, to: string, src: string, dest: string, options: CopyOptions): void {
      const target = linkTarget(src);
      ensureParent(dest);
      try {
        native.symlink(target, dest);
        return;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      if (options.force === false) {
        if (options.errorOnExist) throw copyError("ERR_FS_CP_EEXIST", from, to);
        return;
      }
      if ((native.stat(dest, true).mode & 0o170000) === 0o040000) throw copyError("ERR_FS_CP_NON_DIR_TO_DIR", from, to);
      native.unlink(dest);
      native.symlink(target, dest);
    }
    function copyEntry(from: string, to: string, options: CopyOptions): boolean {
      const src = absolute(from), dest = absolute(to);
      const kind = native.stat(src, true).mode & 0o170000;
      if (src === dest) throw copyError("ERR_FS_CP_EINVAL", from, to);
      if (kind === 0o120000) { copyLink(from, to, src, dest, options); return false; }
      const directory = kind === 0o040000;
      if (directory && dest.startsWith(src.endsWith("/") ? src : `${src}/`)) throw copyError("ERR_FS_CP_EINVAL", from, to);
      if (directory && !options.recursive) throw copyError("ERR_FS_EISDIR", from, to);
      if (directory) { native.mkdir(dest, true); return true; }
      ensureParent(dest);
      try {
        native.copyFile(src, dest, options.force === false ? 1 : 0);
      } catch (error) {
        if (options.force !== false || !isCode(error, "EEXIST")) throw error;
        if ((native.stat(dest, false).mode & 0o170000) === 0o040000) throw copyError("ERR_FS_CP_NON_DIR_TO_DIR", from, to);
        if (options.errorOnExist) throw copyError("ERR_FS_CP_EEXIST", from, to);
      }
      return false;
    }
    function childPath(parent: string, name: string): string { return `${parent.endsWith("/") ? parent.slice(0, -1) : parent}/${name}`; }
    function cpSync(from: string, to: string, options: CopyOptions = {}): void {
      const accepted = options.filter ? options.filter(from, to) : true;
      if (typeof accepted !== "boolean") throw Object.assign(new TypeError("options.filter must return a boolean"), { code: "ERR_INVALID_RETURN_VALUE" });
      if (!accepted || !copyEntry(from, to, options)) return;
      for (const [name] of native.readdir(absolute(from))) cpSync(childPath(from, name), childPath(to, name), options);
    }
    async function cp(from: string, to: string, options: CopyOptions = {}): Promise<void> {
      const accepted = options.filter ? await options.filter(from, to) : true;
      if (!accepted || !copyEntry(from, to, options)) return;
      for (const [name] of native.readdir(absolute(from))) await cp(childPath(from, name), childPath(to, name), options);
    }
    return { flagsNumber, parseFileMode, Stats, BigIntStats, makeStats, timeSpec, cpSync, cp };
  };

  type StatsRecord = Record<string, unknown>;
  type StatsConstructor = ((...args: unknown[]) => StatsRecord) & { prototype: object };

  // Bun's Stats and BigIntStats (src/jsc/bindings/NodeFSStatBinding.cpp): constructors that
  // also work without `new`, taking Node's argument order but laying fields out in Bun's
  // order. The prototypes hold enumerable `is*` methods and date accessors that build a
  // Date from the matching `*Ms` field and cache it as an own property. A receiver that is
  // not an object gets undefined.
  function createStats() {
    "use strict";
    const kArgumentOrder = ["dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks"];
    const kLayout = ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks"];
    const kTimes = ["atime", "mtime", "ctime", "birthtime"];
    const kModeTests: [string, number][] = [
      ["isBlockDevice", 0o060000], ["isCharacterDevice", 0o020000], ["isDirectory", 0o040000], ["isFIFO", 0o010000],
      ["isFile", 0o100000], ["isSocket", 0o140000], ["isSymbolicLink", 0o120000],
    ];
    const isObject = (value: unknown): value is StatsRecord => (typeof value === "object" && value !== null) || typeof value === "function";
    // JSC's toBigInt64: BigInt conversion that refuses numbers, wrapped to 64 bits.
    function bigInt64(value: unknown): bigint {
      if (typeof value === "number") throw new TypeError("Invalid argument type in ToBigInt operation");
      return BigInt.asIntN(64, BigInt(value as bigint));
    }
    function own(target: object, key: string, value: unknown) {
      Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    }

    function fill(target: StatsRecord, args: unknown[], bigint: boolean): StatsRecord {
      const given: StatsRecord = {};
      kArgumentOrder.forEach((key, index) => { given[key] = args[index]; });
      for (const key of kLayout) own(target, key, given[key]);
      const times = kTimes.map((_, index) => args[10 + index]);
      kTimes.forEach((name, index) => own(target, `${name}Ms`, bigint ? Number(bigInt64(times[index])) / 1e6 : times[index]));
      if (bigint) kTimes.forEach((name, index) => own(target, `${name}Ns`, times[index]));
      return target;
    }

    function defineConstructor(name: string, bigint: boolean): StatsConstructor {
      const prototype: StatsRecord = {};
      const create = (target: StatsRecord | undefined, args: unknown[]) => fill(target ?? Object.create(prototype), args, bigint);
      const constructor = {
        [name]: function (this: StatsRecord, ...args: unknown[]) { return create(new.target ? this : undefined, args); },
      }[name] as unknown as StatsConstructor;
      // Native: a fixed prototype, tagged with the class name ("[object Stats]").
      Object.defineProperty(constructor, "prototype", { value: prototype, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(prototype, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
      for (const [method, kind] of kModeTests) own(prototype, method, modeTest(method, kind, bigint));
      for (const field of kTimes) {
        Object.defineProperty(prototype, field, {
          get: dateGetter(field, bigint, prototype), set: dateSetter(field), enumerable: true, configurable: true,
        });
      }
      Object.defineProperty(prototype, "constructor", { value: constructor, writable: true, enumerable: false, configurable: true });
      return constructor;
    }

    function modeTest(method: string, kind: number, bigint: boolean) {
      const test = {
        [method](this: unknown) {
          if (!isObject(this)) return undefined;
          const mode = bigint ? Number(bigInt64(this.mode) & 0o170000n) : Number(this.mode) & 0o170000;
          return mode === kind;
        },
      }[method]!;
      return test;
    }

    function dateGetter(field: string, bigint: boolean, prototype: object) {
      return {
        [field](this: unknown) {
          if (!isObject(this)) return undefined;
          const raw = this[`${field}Ms`];
          const date = new Date(bigint ? Number(bigInt64(raw)) : Number(raw));
          if (this !== prototype) own(this, field, date);
          return date;
        },
      }[field];
    }

    function dateSetter(field: string) {
      return {
        [field](this: unknown, value: unknown) {
          if (isObject(this)) own(this, field, value);
        },
      }[field];
    }

    const Stats = defineConstructor("Stats", false);
    const BigIntStats = defineConstructor("BigIntStats", true);
    // statSync and friends: native records already carry Bun's field names. Bigint records
    // carry integers and decimal strings, converted here.
    function makeStats(raw: StatsRecord, bigint: boolean): StatsRecord {
      const target = Object.create((bigint ? BigIntStats : Stats).prototype);
      const value = (key: string) => bigint && raw[key] !== undefined ? BigInt(raw[key] as string) : raw[key];
      for (const key of kLayout) own(target, key, value(key));
      for (const name of kTimes) own(target, `${name}Ms`, value(`${name}Ms`));
      if (bigint) for (const name of kTimes) own(target, `${name}Ns`, value(`${name}Ns`));
      return target;
    }
    return { Stats, BigIntStats, makeStats };
  }

  // Bun's time_like.rs: utimes takes a number of seconds, a Date or a numeric string. A
  // negative number means now; a non-finite one or any other type is rejected. Returns whole
  // seconds and nanoseconds, with -1 nanoseconds for "now".
  function timeSpec(value: unknown, name: string): [number, number] {
    if (value === undefined) throw invalidTime(`${name} is required`);
    if (typeof value === "number" && Number.isFinite(value) && value < 0) return [0, -1];
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      const [seconds, millis] = euclid(value.getTime(), 1000);
      return [seconds, Math.trunc(millis * 1e6)];
    }
    const seconds = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(seconds)) throw invalidTime(`${name} must be a number or a Date`);
    const [whole, fraction] = euclid(seconds, 1);
    const nanos = fraction * 1e9;
    // A fraction that rounds to 1 (as -1e-17 does) carries into the seconds.
    return nanos >= 1e9 ? [whole + 1, Math.trunc(nanos - 1e9)] : [whole, Math.trunc(nanos)];
  }

  // Rust's f64 div_euclid and rem_euclid for a positive divisor.
  function euclid(value: number, divisor: number): [number, number] {
    const remainder = value % divisor;
    const quotient = Math.trunc(value / divisor);
    return remainder < 0 ? [quotient - 1, remainder + divisor] : [quotient, remainder];
  }

  function invalidTime(message: string): TypeError {
    return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
  }
})
