(function (native: {
  stat(path: string, link: boolean): { mode: number };
  readdir(path: string): [string, string][];
  mkdir(path: string, recursive: boolean): unknown;
  copyFile(from: string, to: string, mode: number): void;
}, absolute: (path: string) => string) {
  const stringFlags: Record<string, number> = {
    r: 0, "r+": 2, rs: 1052672, sr: 1052672, "rs+": 1052674, "sr+": 1052674,
    w: 577, wx: 705, xw: 705, "w+": 578, "wx+": 706, "xw+": 706,
    a: 1089, ax: 1217, xa: 1217, as: 1053761, "a+": 1090, "ax+": 1218, "xa+": 1218, "as+": 1053762,
  };
  function flagsNumber(flags: unknown = "r"): number {
    if (typeof flags === "string" && Object.hasOwn(stringFlags, flags)) return stringFlags[flags]!;
    if (typeof flags === "number" && Number.isInteger(flags) && flags >= 0 && flags <= 2147483647) return flags;
    throw Object.assign(new TypeError(`The argument 'flags' is invalid. Received ${String(flags)}`), { code: "ERR_INVALID_ARG_VALUE" });
  }

  class Stats {
    declare mode: number | bigint;
    declare atimeMs: number | bigint;
    declare mtimeMs: number | bigint;
    declare ctimeMs: number | bigint;
    declare birthtimeMs: number | bigint;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    constructor(raw: Record<string, number | bigint | string>, bigint = false) {
      const fields = bigint ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, BigInt(value)])) : raw;
      Object.assign(this, fields);
      this.atime = new Date(Number(this.atimeMs));
      this.mtime = new Date(Number(this.mtimeMs));
      this.ctime = new Date(Number(this.ctimeMs));
      this.birthtime = new Date(Number(this.birthtimeMs));
    }
    isFile() { return (Number(this.mode) & 0o170000) === 0o100000; }
    isDirectory() { return (Number(this.mode) & 0o170000) === 0o040000; }
    isSymbolicLink() { return (Number(this.mode) & 0o170000) === 0o120000; }
    isBlockDevice() { return (Number(this.mode) & 0o170000) === 0o060000; }
    isCharacterDevice() { return (Number(this.mode) & 0o170000) === 0o020000; }
    isFIFO() { return (Number(this.mode) & 0o170000) === 0o010000; }
    isSocket() { return (Number(this.mode) & 0o170000) === 0o140000; }
  }

  type CopyOptions = { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (from: string, to: string) => boolean | Promise<boolean> };
  function copyError(code: string, from: string, to: string): Error {
    return Object.assign(new Error(`${code}: cannot copy '${from}' to '${to}'`), { code, path: from, dest: to, syscall: "cp" });
  }
  function isCode(error: unknown, code: string): boolean {
    return error !== null && typeof error === "object" && "code" in error && error.code === code;
  }
  function copyEntry(from: string, to: string, options: CopyOptions): boolean {
    const src = absolute(from), dest = absolute(to);
    const directory = (native.stat(src, false).mode & 0o170000) === 0o040000;
    if (src === dest || (directory && dest.startsWith(src.endsWith("/") ? src : `${src}/`))) throw copyError("ERR_FS_CP_EINVAL", from, to);
    if (directory && !options.recursive) throw copyError("ERR_FS_EISDIR", from, to);
    if (directory) { native.mkdir(dest, true); return true; }
    try {
      native.copyFile(src, dest, options.force === false ? 1 : 0);
    } catch (error) {
      if (options.force !== false || !isCode(error, "EEXIST")) throw error;
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
  return { flagsNumber, Stats, cpSync, cp };
})
