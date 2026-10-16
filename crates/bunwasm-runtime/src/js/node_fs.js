// node:fs and node:fs/promises over the synchronous WASI natives. Callback and
// promise flavours run the sync operation and deliver the result on a later
// turn of the event loop, like Node does.
(function (internal) {
  "use strict";
  const native = internal.native;
  const { Buffer } = internal.require("buffer");

  const constants = {
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512,
    O_APPEND: 1024, O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_SYNC: 1052672, O_DSYNC: 4096,
    O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192, S_IFBLK: 24576,
    S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152, S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128,
    S_IXUSR: 64, S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8, S_IRWXO: 7, S_IROTH: 4,
    S_IWOTH: 2, S_IXOTH: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
    UV_FS_COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4,
  };

  function invalidArg(name, expected, value) {
    const err = new TypeError(`The "${name}" argument must be ${expected}. Received ${internal.describe(value)}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    return err;
  }

  // Paths may be strings, Buffers or file: URLs. Relative paths resolve
  // against process.cwd() (WASI has no kernel cwd of its own).
  function toPath(path, name = "path") {
    let p;
    if (typeof path === "string") p = path;
    else if (path instanceof String) p = String.prototype.valueOf.call(path);
    else if (path instanceof Uint8Array) p = native.utf8Decode(path);
    else if (path instanceof URL) {
      if (path.protocol !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
      p = decodeURIComponent(path.pathname);
    } else throw invalidArg(name, "of type string or an instance of Buffer or URL", path);
    if (p.includes("\0")) throw Object.assign(new TypeError(`The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(p)}`), { code: "ERR_INVALID_ARG_VALUE" });
    return p;
  }

  function absolute(p) {
    if (p.startsWith("/")) return p;
    return internal.require("path").resolve(p);
  }

  // Run a native call against the absolute path but report errors with the
  // path the caller passed, like Node.
  function withPath(path, fn) {
    const given = toPath(path);
    try {
      return fn(absolute(given), given);
    } catch (err) {
      if (err && typeof err.path === "string" && err.path !== given) {
        err.message = err.message.replace(`'${err.path}'`, `'${given}'`);
        err.path = given;
      }
      throw err;
    }
  }

  function encodingOf(options) {
    if (typeof options === "string") return options;
    if (options && typeof options === "object") return options.encoding || null;
    return null;
  }

  function toBytes(data, encoding) {
    if (typeof data === "string") return encoding && encoding !== "utf8" && encoding !== "utf-8" ? Buffer.from(data, encoding) : data;
    if (ArrayBuffer.isView(data)) return internal.toUint8(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw invalidArg("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  }

  function asBuffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // --- Stats / Dirent ---------------------------------------------------------

  class Stats {
    constructor(raw) {
      Object.assign(this, raw);
      this.atime = new Date(raw.atimeMs);
      this.mtime = new Date(raw.mtimeMs);
      this.ctime = new Date(raw.ctimeMs);
      this.birthtime = new Date(raw.birthtimeMs);
    }
    isFile() {
      return (this.mode & constants.S_IFMT) === constants.S_IFREG;
    }
    isDirectory() {
      return (this.mode & constants.S_IFMT) === constants.S_IFDIR;
    }
    isSymbolicLink() {
      return (this.mode & constants.S_IFMT) === constants.S_IFLNK;
    }
    isBlockDevice() {
      return false;
    }
    isCharacterDevice() {
      return false;
    }
    isFIFO() {
      return false;
    }
    isSocket() {
      return false;
    }
  }

  class Dirent {
    constructor(name, kind, parentPath) {
      this.name = name;
      this.parentPath = parentPath;
      this.path = parentPath;
      Object.defineProperty(this, "_kind", { value: kind });
    }
    isFile() {
      return this._kind === "file";
    }
    isDirectory() {
      return this._kind === "dir";
    }
    isSymbolicLink() {
      return this._kind === "symlink";
    }
    isBlockDevice() {
      return false;
    }
    isCharacterDevice() {
      return false;
    }
    isFIFO() {
      return false;
    }
    isSocket() {
      return false;
    }
  }

  function directoryOptions(options) {
    if (options == null) options = {};
    if (typeof options === "string") options = { encoding: options };
    if (typeof options !== "object") throw invalidArg("options", "of type object", options);
    const encoding = options.encoding || "utf8";
    if (encoding !== "buffer" && !Buffer.isEncoding(encoding)) {
      throw Object.assign(new TypeError(`The argument 'encoding' is invalid. Received ${String(encoding)}`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    const bufferSize = options.bufferSize === undefined ? 32 : options.bufferSize;
    if (typeof bufferSize !== "number") throw invalidArg("options.bufferSize", "of type number", bufferSize);
    if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 4294967295) {
      throw Object.assign(new RangeError(`The value of "options.bufferSize" is out of range. Received ${bufferSize}`), { code: "ERR_OUT_OF_RANGE" });
    }
    return { encoding, bufferSize, recursive: Boolean(options.recursive) };
  }

  function directoryClosed() {
    return Object.assign(new Error("Directory handle was closed"), { code: "ERR_DIR_CLOSED" });
  }

  const directoryCleanup = new FinalizationRegistry((handle) => native.releaseDir(handle));

  class Dir {
    #handle;
    #path;
    #lookupPath;
    #options;
    #entries = [];
    #index = 0;
    #operations = [];
    #active = false;

    constructor(handle, lookupPath, publicPath, options) {
      this.#handle = handle;
      this.#path = publicPath;
      this.#lookupPath = lookupPath;
      this.#options = options;
      directoryCleanup.register(this, handle, this);
    }
    get path() {
      if (!(#path in this)) throw Object.assign(new TypeError('Value of "this" must be of type Dir'), { code: "ERR_INVALID_THIS" });
      return this.#path;
    }
    #checkOpen() {
      if (this.#handle === null) throw directoryClosed();
    }
    #checkSync() {
      this.#checkOpen();
      if (this.#active || this.#operations.length !== 0) {
        throw Object.assign(new Error("Cannot do synchronous work on directory handle with concurrent asynchronous operations"), { code: "ERR_DIR_CONCURRENT_OPERATION" });
      }
    }
    #readEntry() {
      this.#checkOpen();
      if (this.#index === this.#entries.length) {
        this.#entries = native.readDir(this.#handle, this.#options.bufferSize);
        this.#index = 0;
      }
      if (this.#entries.length === 0) return null;
      const [bytes, kind, parentPath] = this.#entries[this.#index++];
      const buffer = asBuffer(bytes);
      const name = this.#options.encoding === "buffer" ? buffer : buffer.toString(this.#options.encoding);
      const parent = this.#path instanceof Uint8Array ? (parentPath === this.#lookupPath ? this.#path : Buffer.from(parentPath)) : parentPath;
      return new Dirent(name, kind, parent);
    }
    #closeHandle() {
      this.#checkOpen();
      const handle = this.#handle;
      this.#handle = null;
      directoryCleanup.unregister(this);
      native.closeDir(handle);
      this.#entries = [];
    }
    #enqueue(operation, callback) {
      if (callback !== undefined && typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
      if (callback === undefined) return new Promise((resolve, reject) => this.#enqueue(operation, (error, result) => error ? reject(error) : resolve(result)));
      const buffered = operation === "read" && this.#index < this.#entries.length;
      if (this.#operations.length === 0 && (buffered || operation === "close")) {
        const { error, result } = this.#run(operation);
        later(() => operation === "close" ? callback(error) : callback(error, result));
        return;
      }
      this.#operations.push({ operation, callback });
      if (this.#operations.length === 1) later(() => this.#drain());
    }
    #run(operation) {
      try { return { error: null, result: operation === "read" ? this.#readEntry() : this.#closeHandle() }; }
      catch (error) { return { error, result: undefined }; }
    }
    #drain() {
      const { operation, callback } = this.#operations[0];
      this.#active = operation === "read" && this.#index === this.#entries.length;
      const { error, result } = this.#run(operation);
      this.#operations.shift();
      if (this.#operations.length !== 0) later(() => this.#drain());
      try {
        if (operation === "close") callback(error);
        else callback(error, result);
      } finally {
        this.#active = false;
      }
    }
    readSync() {
      this.#checkSync();
      return this.#readEntry();
    }
    read(callback) {
      if (arguments.length > 0) {
        this.#checkOpen();
        if (callback === undefined) throw invalidArg("callback", "of type function", callback);
      }
      return this.#enqueue("read", callback);
    }
    closeSync() {
      this.#checkSync();
      this.#closeHandle();
    }
    close(callback) {
      return this.#enqueue("close", callback);
    }
    [Symbol.dispose]() {
      if (this.#handle !== null) this.closeSync();
    }
    async [Symbol.asyncDispose]() {
      if (this.#handle !== null) await this.close();
    }
    async *[Symbol.asyncIterator]() {
      try {
        let entry;
        while ((entry = await this.read()) !== null) yield entry;
      } finally {
        await this.close();
      }
    }
  }

  function opendirSync(path, options) {
    const given = toPath(path);
    if (given === "") throw Object.assign(new Error("ENOENT: no such file or directory, opendir ''"), { code: "ENOENT", errno: -2, syscall: "opendir", path: given });
    const config = directoryOptions(options);
    const publicPath = path instanceof Uint8Array ? path : given;
    return new Dir(native.opendir(given === "" ? "" : absolute(given), given, config.recursive), given, publicPath, config);
  }

  function opendir(path, options, callback) {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
    const given = toPath(path);
    const config = directoryOptions(options);
    let result, error = null;
    if (given === "") {
      later(() => callback(Object.assign(new Error("ENOENT: no such file or directory, opendir ''"), { code: "ENOENT", errno: -2, syscall: "opendir", path: given })));
      return;
    }
    const publicPath = path instanceof Uint8Array ? path : given;
    try { result = new Dir(native.opendir(given === "" ? "" : absolute(given), given, config.recursive), given, publicPath, config); }
    catch (err) { error = err; }
    later(() => callback(error, result));
  }

  // --- sync API ---------------------------------------------------------------

  function readFileSync(path, options) {
    const encoding = encodingOf(options);
    const bytes = typeof path === "number" ? readAllFd(path) : withPath(path, (abs) => native.readFile(abs));
    const buf = asBuffer(bytes);
    return encoding ? buf.toString(encoding) : buf;
  }

  function readAllFd(fd) {
    if (fd === 0) return native.readStdin();
    const chunks = [];
    for (;;) {
      const chunk = native.read(fd, 65536, -1);
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }
    return internal.concatBytes(chunks);
  }

  function writeFileSync(path, data, options) {
    const encoding = encodingOf(options);
    const flag = (options && typeof options === "object" && options.flag) || "w";
    const bytes = toBytes(data, encoding);
    if (typeof path === "number") {
      native.write(path, bytes, -1);
      return;
    }
    withPath(path, (abs) => native.writeFile(abs, bytes, flag.startsWith("a")));
  }

  function appendFileSync(path, data, options) {
    const bytes = toBytes(data, encodingOf(options));
    if (typeof path === "number") {
      native.write(path, bytes, -1);
      return;
    }
    withPath(path, (abs) => native.writeFile(abs, bytes, true));
  }

  function existsSync(path) {
    try {
      return native.exists(absolute(toPath(path)));
    } catch {
      return false;
    }
  }

  function statSync(path, options) {
    try {
      return new Stats(withPath(path, (abs) => native.stat(abs, false)));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  function lstatSync(path, options) {
    try {
      return new Stats(withPath(path, (abs) => native.stat(abs, true)));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  function mkdirSync(path, options) {
    const recursive = Boolean(options && typeof options === "object" && options.recursive);
    const created = withPath(path, (abs) => native.mkdir(abs, recursive));
    return recursive ? (created === null ? undefined : created) : undefined;
  }

  function readdirSync(path, options) {
    const withFileTypes = Boolean(options && options.withFileTypes);
    const recursive = Boolean(options && options.recursive);
    const encoding = encodingOf(options);
    return withPath(path, (abs, given) => {
      const out = [];
      collectDir(abs, given, "", recursive, withFileTypes, out);
      if (encoding === "buffer") return out.map((n) => (typeof n === "string" ? Buffer.from(n) : n));
      return out;
    });
  }

  function collectDir(abs, given, prefix, recursive, withFileTypes, out) {
    for (const [name, kind] of native.readdir(abs)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push(withFileTypes ? new Dirent(name, kind, prefix ? `${given}/${prefix}` : given) : rel);
      if (recursive && kind === "dir") collectDir(`${abs}/${name}`, given, rel, recursive, withFileTypes, out);
    }
  }

  function rmSync(path, options = {}) {
    withPath(path, (abs) => native.rm(abs, Boolean(options.recursive), Boolean(options.force)));
  }

  function rmdirSync(path, options = {}) {
    withPath(path, (abs) => native.rmdir(abs, Boolean(options.recursive)));
  }

  function unlinkSync(path) {
    withPath(path, (abs) => native.unlink(abs));
  }

  function renameSync(from, to) {
    withPath(from, (abs) => native.rename(abs, absolute(toPath(to, "newPath"))));
  }

  function copyFileSync(from, to, mode) {
    const dest = absolute(toPath(to, "dest"));
    if (mode & constants.COPYFILE_EXCL && native.exists(dest)) {
      const err = new Error(`EEXIST: file already exists, copyfile '${toPath(from)}' -> '${toPath(to)}'`);
      Object.assign(err, { code: "EEXIST", errno: -17, syscall: "copyfile", path: toPath(from) });
      throw err;
    }
    withPath(from, (abs) => native.copyFile(abs, dest));
  }

  function cpSync(from, to, options = {}) {
    const src = absolute(toPath(from, "src"));
    const dest = absolute(toPath(to, "dest"));
    const st = native.stat(src, false);
    if ((st.mode & constants.S_IFMT) === constants.S_IFDIR) {
      if (!options.recursive) {
        const err = new Error(`Recursive option is required to copy a directory: ${toPath(from)}`);
        err.code = "ERR_FS_EISDIR";
        throw err;
      }
      native.copyDir(src, dest);
      return;
    }
    native.copyFile(src, dest);
  }

  function realpathSync(path) {
    return withPath(path, (abs) => native.realpath(abs));
  }
  realpathSync.native = realpathSync;

  function accessSync(path, mode) {
    void mode;
    withPath(path, (abs) => native.stat(abs, false));
  }

  function mkdtempSync(prefix) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (;;) {
      const bytes = native.randomBytes(6);
      const suffix = Array.from(bytes, (b) => chars[b % chars.length]).join("");
      const path = toPath(prefix, "prefix") + suffix;
      if (native.exists(absolute(path))) continue;
      native.mkdir(absolute(path), false);
      return path;
    }
  }

  function flagsString(flags) {
    if (flags === undefined || flags === null) return "r";
    if (typeof flags === "string") return flags;
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL } = constants;
    const plus = flags & O_RDWR ? "+" : "";
    const excl = flags & O_EXCL ? "x" : "";
    if (flags & O_APPEND) return "a" + excl + plus;
    if (flags & (O_CREAT | O_TRUNC) || flags & O_WRONLY) return "w" + excl + plus;
    return "r" + plus;
  }

  function openSync(path, flags) {
    return withPath(path, (abs) => native.open(abs, flagsString(flags)));
  }

  function closeSync(fd) {
    native.close(fd);
  }

  function readSync(fd, buffer, offsetOrOptions, length, position) {
    let offset = offsetOrOptions;
    if (offsetOrOptions !== null && typeof offsetOrOptions === "object") {
      ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions);
    }
    offset = offset || 0;
    if (length === undefined) length = buffer.byteLength - offset;
    const chunk = native.read(fd, length, position === null || position === undefined ? -1 : Number(position));
    internal.toUint8(buffer).set(chunk, offset);
    return chunk.length;
  }

  function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
    if (typeof data === "string") {
      const bytes = toBytes(data, typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8");
      return native.write(fd, bytes, typeof offsetOrPosition === "number" ? offsetOrPosition : -1);
    }
    const view = internal.toUint8(data);
    const offset = offsetOrPosition || 0;
    const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : view.byteLength - offset;
    return native.write(fd, view.slice(offset, offset + length), typeof position === "number" ? position : -1);
  }

  function validateFd(fd) {
    if (typeof fd !== "number") throw invalidArg("fd", "of type number", fd);
    if (Number.isInteger(fd) && fd >= 0 && fd <= 2147483647) return;
    const expected = Number.isInteger(fd) ? ">= 0 && <= 2147483647" : "an integer";
    const error = new RangeError(`The value of "fd" is out of range. It must be ${expected}. Received ${internal.describe(fd)}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }

  function validateWritev(buffers) {
    if (!Array.isArray(buffers)) throw invalidArg("buffers", "an array", buffers);
    for (const buffer of buffers) {
      if (!ArrayBuffer.isView(buffer)) throw invalidArg("buffers", "an array of ArrayBufferView instances", buffers);
    }
  }

  function writeBuffers(fd, buffers, position) {
    if (buffers.length === 0) return 0;
    const at = typeof position === "number" && position >= 0 ? position : -1;
    return native.writev(fd, buffers.map(internal.toUint8), at);
  }

  function writevSync(fd, buffers, position) {
    validateWritev(buffers);
    if (buffers.length === 0) return 0;
    validateFd(fd);
    return writeBuffers(fd, buffers, position);
  }

  function writev(fd, buffers, position, callback) {
    if (typeof position === "function") { callback = position; position = null; }
    validateFd(fd);
    validateWritev(buffers);
    if (typeof callback !== "function") throw invalidArg("cb", "of type function", callback);
    let written = 0;
    let error = null;
    try { written = writeBuffers(fd, buffers, position); } catch (err) { error = err; }
    later(() => callback(error, written, buffers));
  }

  const noop = () => {};

  function globSync(pattern, options) {
    const patterns = typeof pattern === "string" ? [pattern] : pattern;
    if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) throw invalidArg("pattern", "a string or an array of strings", pattern);
    if (options == null) options = {};
    if (typeof options !== "object") throw invalidArg("options", "an object", options);
    const exclude = options.exclude;
    if (exclude !== undefined && typeof exclude !== "function" && (!Array.isArray(exclude) || exclude.some((p) => typeof p !== "string"))) throw invalidArg("options.exclude", "a function or an array of strings", exclude);
    for (const key of ["withFileTypes", "followSymlinks"]) {
      if (options[key] !== undefined && typeof options[key] !== "boolean") throw invalidArg("options." + key, "a boolean", options[key]);
    }
    const path = internal.require("path");
    let givenCwd = options.cwd === undefined ? process.cwd() : options.cwd;
    if (givenCwd instanceof String) givenCwd = String(givenCwd);
    const cwd = path.resolve(toPath(givenCwd, "options.cwd"));
    const withTypes = options.withFileTypes === true;
    const excluded = new Map();
    const found = new Set();
    const out = [];
    function dirent(p) {
      const abs = path.resolve(cwd, p);
      const stat = lstatSync(abs);
      return new Dirent(path.basename(p), stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file", path.dirname(abs));
    }
    function isExcluded(p) {
      if (!exclude) return false;
      if (excluded.has(p)) return excluded.get(p);
      const parent = path.dirname(p);
      const ancestor = parent !== "." && parent !== "/" && parent !== p && isExcluded(parent);
      const skip = ancestor || (typeof exclude === "function" ? exclude(withTypes ? dirent(p) : p) : exclude.some((g) => native.globMatch(g, p)));
      excluded.set(p, !!skip);
      return !!skip;
    }
    for (const glob of patterns) {
      let paths = native.globScan(glob, cwd, false, false, options.followSymlinks === true, false, false, true);
      if (glob.endsWith("/**")) {
        const base = glob.slice(0, -3) || ".";
        const parents = native.globScan(base, cwd, false, false, options.followSymlinks === true, false, false, true);
        paths = parents.concat(paths);
      }
      for (const p of paths) {
        if (found.has(p) || isExcluded(p)) continue;
        found.add(p);
        out.push(withTypes ? dirent(p) : p);
      }
    }
    return out;
  }

  function glob(pattern, options, callback) {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
    let result, error = null;
    try { result = globSync(pattern, options); } catch (err) { error = err; }
    later(() => callback(error, result));
  }

  const sync = {
    readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync, mkdirSync, readdirSync,
    rmSync, rmdirSync, unlinkSync, renameSync, copyFileSync, cpSync, realpathSync, accessSync, mkdtempSync,
    openSync, closeSync, readSync, writeSync, writevSync, globSync, opendirSync,
    fstatSync: (fd) => new Stats(native.fstat(fd)),
    ftruncateSync: (fd, len) => native.ftruncate(fd, len || 0),
    truncateSync: (path, len) => withPath(path, (abs) => native.truncate(abs, len || 0)),
    readlinkSync: (path) => withPath(path, (abs) => native.readlink(abs)),
    symlinkSync: (target, path) => withPath(path, (abs) => native.symlink(toPath(target, "target"), abs)),
    linkSync: (from, to) => withPath(from, (abs) => native.link(abs, absolute(toPath(to, "newPath")))),
    chmodSync: (path) => void statSync(path),
    lchmodSync: noop,
    fchmodSync: noop,
    chownSync: (path) => void statSync(path),
    lchownSync: noop,
    fchownSync: noop,
    utimesSync: (path) => void statSync(path),
    lutimesSync: noop,
    futimesSync: noop,
    fsyncSync: noop,
    fdatasyncSync: noop,
  };

  // --- callback API -----------------------------------------------------------

  // Deliver on the "poll" phase: setImmediate keeps the loop alive until then.
  function later(fn) {
    setImmediate(fn);
  }

  function callbackify(name, fn, shape) {
    return function (...args) {
      const callback = args.pop();
      if (typeof callback !== "function") throw invalidArg("cb", "of type function", callback);
      let result;
      let error = null;
      try {
        result = fn.apply(undefined, args);
      } catch (err) {
        error = err;
      }
      later(() => (shape ? shape(callback, error, result, args) : callback(error, result)));
    };
  }

  const callbackApi = {};
  for (const name of Object.keys(sync)) {
    callbackApi[name.slice(0, -4)] = callbackify(name, sync[name]);
  }
  // fs.exists(path, cb) passes only a boolean.
  callbackApi.exists = function exists(path, callback) {
    const result = existsSync(path);
    later(() => callback(result));
  };
  callbackApi.glob = glob;
  callbackApi.opendir = opendir;
  callbackApi.writev = writev;
  callbackApi.read = callbackify("read", readSync, (cb, err, n, args) => cb(err, n, args[1]));
  callbackApi.write = callbackify("write", writeSync, (cb, err, n, args) => cb(err, n, args[1]));

  // --- promises ---------------------------------------------------------------

  function promisifySync(fn) {
    return function (...args) {
      return new Promise((resolve, reject) => {
        let result;
        try {
          result = fn.apply(undefined, args);
        } catch (err) {
          later(() => reject(err));
          return;
        }
        later(() => resolve(result));
      });
    };
  }

  class FileHandle {
    constructor(fd) {
      this.fd = fd;
    }
    async readFile(options) {
      return readFileSync(this.fd, options);
    }
    async writeFile(data, options) {
      return writeFileSync(this.fd, data, options);
    }
    async appendFile(data, options) {
      return appendFileSync(this.fd, data, options);
    }
    async read(buffer, offset, length, position) {
      const target = buffer || Buffer.alloc(16384);
      const bytesRead = readSync(this.fd, target, offset, length, position);
      return { bytesRead, buffer: target };
    }
    async write(data, offset, length, position) {
      const bytesWritten = writeSync(this.fd, data, offset, length, position);
      return { bytesWritten, buffer: data };
    }
    async writev(buffers, position) {
      return { bytesWritten: writevSync(this.fd, buffers, position), buffers };
    }
    async stat() {
      return new Stats(native.fstat(this.fd));
    }
    async truncate(len) {
      native.ftruncate(this.fd, len || 0);
    }
    async sync() {}
    async datasync() {}
    async close() {
      native.close(this.fd);
    }
    async [Symbol.asyncDispose]() {
      return this.close();
    }
  }

  const promises = {};
  for (const name of Object.keys(sync)) {
    promises[name.slice(0, -4)] = promisifySync(sync[name]);
  }
  promises.glob = async function* glob(pattern, options) { yield* globSync(pattern, options); };
  promises.open = async (path, flags) => new FileHandle(openSync(path, flags));
  promises.constants = constants;
  delete promises.close;
  delete promises.fstat;
  delete promises.ftruncate;

  // --- streams (minimal: whole-file reads, synchronous writes) --------------

  function createReadStream(path, options = {}) {
    const EventEmitter = internal.require("events");
    const stream = new EventEmitter();
    const encoding = encodingOf(options);
    stream.path = path;
    stream.readable = true;
    stream.setEncoding = (enc) => {
      stream._encoding = enc;
      return stream;
    };
    stream.pipe = (dest) => {
      stream.on("data", (chunk) => dest.write(chunk));
      stream.on("end", () => dest !== globalThis.process.stdout && dest.end && dest.end());
      return dest;
    };
    stream.destroy = () => stream;
    stream[Symbol.asyncIterator] = async function* () {
      yield readChunk();
    };
    function readChunk() {
      let buf = readFileSync(path);
      if (options.start !== undefined || options.end !== undefined) buf = buf.subarray(options.start || 0, options.end === undefined ? undefined : options.end + 1);
      const enc = stream._encoding || encoding;
      return enc ? buf.toString(enc) : buf;
    }
    later(() => {
      let chunk;
      try {
        chunk = readChunk();
      } catch (err) {
        stream.emit("error", err);
        return;
      }
      stream.emit("open");
      stream.emit("ready");
      if (chunk.length > 0) stream.emit("data", chunk);
      stream.emit("end");
      stream.emit("close");
    });
    return stream;
  }

  function createWriteStream(path, options = {}) {
    const EventEmitter = internal.require("events");
    const stream = new EventEmitter();
    const flags = (typeof options === "object" && options.flags) || "w";
    const fd = openSync(path, flags);
    stream.path = path;
    stream.fd = fd;
    stream.writable = true;
    stream.bytesWritten = 0;
    stream.write = (chunk, encoding, cb) => {
      if (typeof encoding === "function") cb = encoding;
      stream.bytesWritten += writeSync(fd, chunk, undefined, typeof encoding === "string" ? encoding : undefined);
      if (typeof cb === "function") later(cb);
      return true;
    };
    stream.end = (chunk, encoding, cb) => {
      if (typeof chunk === "function") cb = chunk;
      else if (chunk !== undefined && chunk !== null) stream.write(chunk, encoding);
      closeSync(fd);
      stream.writable = false;
      later(() => {
        stream.emit("finish");
        stream.emit("close");
        if (typeof cb === "function") cb();
      });
      return stream;
    };
    stream.close = (cb) => stream.end(cb);
    stream.destroy = () => stream;
    later(() => {
      stream.emit("open", fd);
      stream.emit("ready");
    });
    return stream;
  }

  function watchUnsupported() {
    throw Object.assign(new Error("fs.watch is not supported in bun-wasm"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
  }

  const fs = Object.assign({}, sync, callbackApi, {
    promises,
    constants,
    Stats,
    Dirent,
    Dir,
    createReadStream,
    createWriteStream,
    watch: watchUnsupported,
    watchFile: watchUnsupported,
    unwatchFile: () => {},
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
  });

  return { fs, promises };
})
