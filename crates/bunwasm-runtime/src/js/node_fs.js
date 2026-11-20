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
    // Bun's PathLike also takes a DataView or an ArrayBuffer of path bytes.
    else if (path instanceof DataView) p = native.utf8Decode(new Uint8Array(path.buffer, path.byteOffset, path.byteLength));
    else if (path instanceof ArrayBuffer) p = native.utf8Decode(new Uint8Array(path));
    else if (path instanceof URL) {
      if (path.protocol !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
      p = decodeURIComponent(path.pathname);
    } else throw invalidArg(name, "of type string or an instance of Buffer or URL", path);
    if (p.includes("\0")) throw Object.assign(new TypeError(`The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(p)}`), { code: "ERR_INVALID_ARG_VALUE" });
    return p;
  }

  function absolute(p) {
    if (p === "" || p.startsWith("/")) return p;
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

  // The encoding option of an fs call, rejected the way Bun does when it is not one Buffer knows.
  function encodingOf(options) {
    const encoding = typeof options === "string" ? options : options && typeof options === "object" ? options.encoding || null : null;
    if (encoding === null || encoding === "buffer" || Buffer.isEncoding(encoding)) return encoding;
    throw Object.assign(new TypeError(`encoding '${String(encoding)}' is an invalid encoding`), { code: "ERR_INVALID_ARG_VALUE" });
  }

  function toBytes(data, encoding) {
    // Bun writes a string given the "buffer" encoding as Latin-1 bytes.
    if (typeof data === "string" && encoding === "buffer") return Buffer.from(data, "latin1");
    if (typeof data === "string") return encoding && encoding !== "utf8" && encoding !== "utf-8" ? Buffer.from(data, encoding) : data;
    if (ArrayBuffer.isView(data)) return internal.toUint8(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw invalidArg("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  }

  function asBuffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // --- Stats / Dirent ---------------------------------------------------------

  const { Stats, makeStats, timeSpec, flagsNumber, parseFileMode, cpSync: copySync, cp: copyAsync } = internal.require("fs_options")(native, absolute, (value) => internal.require("inspect").nodeInspect(value));

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
    #token = {};
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
      directoryCleanup.register(this, handle, this.#token);
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
      directoryCleanup.unregister(this.#token);
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

  // Like Bun, a byte path is read before the options, so an option getter that changes
  // the path's buffer cannot change which file is used. Strings cannot change.
  function readFileSync(path, options) {
    if (typeof path !== "number" && typeof path !== "string") path = toPath(path);
    const encoding = encodingOf(options);
    // Node validates the flag before opening; the read itself does not use it here.
    // A null or undefined flag means the default, as in Bun.
    flagsNumber((options && typeof options === "object" ? options.flag : undefined) ?? "r");
    const bytes = typeof path === "number" ? readAllFd(path) : withPath(path, (abs) => native.readFile(abs));
    const buf = asBuffer(bytes);
    return encoding && encoding !== "buffer" ? buf.toString(encoding) : buf;
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
    if (typeof path !== "number" && typeof path !== "string") path = toPath(path);
    const encoding = encodingOf(options);
    const flag = (options && typeof options === "object" ? options.flag : undefined) ?? "w";
    const bytes = toBytes(data, encoding);
    if (typeof path === "number") {
      native.write(path, bytes, -1);
      return;
    }
    withPath(path, (abs) => native.writeFileFlags(abs, bytes, flagsNumber(flag), parseFileMode(options && typeof options === "object" ? options.mode : undefined, "mode", 0o666)));
  }

  function appendFileSync(path, data, options) {
    const config = typeof options === "string" ? { encoding: options } : options || {};
    return writeFileSync(path, data, Object.assign({}, config, { flag: config.flag === undefined ? "a" : config.flag }));
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
      return makeStats(withPath(path, (abs) => native.stat(abs, false, Boolean(options && options.bigint))), Boolean(options && options.bigint));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  function lstatSync(path, options) {
    try {
      return makeStats(withPath(path, (abs) => native.stat(abs, true, Boolean(options && options.bigint))), Boolean(options && options.bigint));
    } catch (err) {
      if (options && options.throwIfNoEntry === false && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  function mkdirSync(path, options) {
    if (typeof path !== "string") path = toPath(path);
    const recursive = Boolean(options && typeof options === "object" && options.recursive);
    // Node validates the mode (a number or string argument, or options.mode); WASI applies none.
    parseFileMode(options && typeof options === "object" ? options.mode : options, "mode", 0o777);
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

  function copyFileSync(from, to, mode = 0) {
    withPath(from, (abs) => native.copyFile(abs, absolute(toPath(to, "dest")), mode));
  }

  function cpSync(from, to, options = {}) {
    return copySync(toPath(from, "src"), toPath(to, "dest"), options);
  }

  function cp(from, to, options, callback) {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
    promises.cp(from, to, options).then(() => later(() => callback(null)), error => later(() => callback(error)));
  }

  function realpathSync(path, options) {
    encodingOf(options);
    return withPath(path, (abs) => native.realpath(abs === "" ? absolute(".") : abs));
  }
  realpathSync.native = realpathSync;

  // Bun converts the path, then both times, then sets them (utimensat, or without
  // following a final symlink for lutimes).
  function setPathTimes(path, atime, mtime, noFollow) {
    const given = toPath(path);
    const times = timeSpec(atime, "atime").concat(timeSpec(mtime, "mtime"));
    withPath(given, (abs) => native.utimes(abs, ...times, noFollow));
  }

  function accessSync(path, mode) {
    void mode;
    withPath(path, (abs) => native.stat(abs, false));
  }

  // Bun's mkdtemp errors carry syscall "mkdtemp" and the generated path, in Bun's key
  // order. An empty prefix is EINVAL and names Bun's template, "XXXXX".
  function mkdtempError(code, errno, path, description) {
    const message = description === undefined ? `${code}, mkdtemp '${path}'` : `${code}: ${description}, mkdtemp '${path}'`;
    return Object.assign(new Error(message), { code, path, syscall: "mkdtemp", errno });
  }

  function mkdtempPath(path, encoding) {
    if (encoding === "buffer") return Buffer.from(path);
    if (encoding && encoding !== "utf8" && encoding !== "utf-8") return Buffer.from(path).toString(encoding);
    return path;
  }

  function mkdtempSync(prefix, options) {
    const encoding = encodingOf(options);
    if (prefix instanceof Uint8Array && prefix.byteLength === 0) {
      throw Object.assign(new TypeError("Invalid path buffer: can't be empty"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const given = toPath(prefix, "prefix");
    if (given === "") throw mkdtempError("EINVAL", -22, "XXXXX", "invalid argument");
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (;;) {
      const suffix = Array.from(native.randomBytes(6), (b) => chars[b % chars.length]).join("");
      const path = given + suffix;
      try {
        native.mkdir(absolute(path), false);
      } catch (err) {
        if (err && err.code === "EEXIST") continue;
        if (!err || typeof err.code !== "string") throw err;
        throw mkdtempError(err.code, err.errno, path, internal.require("uv_errors").message(err.code));
      }
      return mkdtempPath(path, encoding);
    }
  }

  function openSync(path, flags, mode) {
    return withPath(path, (abs) => native.open(abs, flagsNumber(flags), parseFileMode(mode, "mode", 0o666)));
  }

  function closeSync(fd) {
    native.close(fd);
  }

  function readOptions(buffer, offsetOrOptions, length, position) {
    if (!ArrayBuffer.isView(buffer)) throw invalidArg("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    let offset = offsetOrOptions;
    if (offsetOrOptions == null || typeof offsetOrOptions === "object") {
      ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions || {});
    }
    if (typeof offset !== "number") throw invalidArg("offset", "of type number", offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw readRange("offset", offset);
    if (length === undefined) length = buffer.byteLength - offset;
    length = Number(length);
    if (!Number.isSafeInteger(length) || length < 0) throw readRange("length", length);
    // Zero-byte reads allow an offset beyond the view. Bun also ignores position in this case.
    if (length === 0) return { offset, length, position };
    if (buffer.byteLength === 0) throw Object.assign(new TypeError("The argument 'buffer' is empty and cannot be written"), { code: "ERR_INVALID_ARG_VALUE" });
    if (offset > buffer.byteLength || length > buffer.byteLength - offset) throw readRange("length", length);
    return { offset, length, position };
  }

  function readRange(name, value) {
    return Object.assign(new RangeError(`The value of "${name}" is out of range. Received ${value}`), { code: "ERR_OUT_OF_RANGE" });
  }

  // Each native read returns a fresh copy of its bytes. Reading a large regular
  // file in one call (webpack's cache reads a whole pack) needs two more
  // contiguous blocks of the full size beside the destination; bounded pieces
  // fill the destination the same way, stopping at end of file.
  const kReadPiece = 1 << 20;
  function readRegularPieces(fd, target, offset, length, position) {
    let count = 0;
    while (count < length) {
      const want = Math.min(kReadPiece, length - count);
      const chunk = readVectorChunk(fd, want, position < 0 ? -1 : position + count, count);
      if (chunk === null) return count;
      target.set(chunk, offset + count);
      count += chunk.length;
      if (chunk.length < want) return count;
    }
    return count;
  }

  function readSync(fd, buffer, offsetOrOptions, length, position) {
    validateFd(fd);
    const options = readOptions(buffer, offsetOrOptions, length, position);
    // Public zero-byte reads return without a syscall, even on a closed descriptor.
    // Direct native callers still validate empty reads for ABI safety.
    if (options.length === 0) return 0;
    const at = options.position === null || options.position === undefined ? -1 : Number(options.position);
    const target = internal.toUint8(buffer);
    if (options.length > kReadPiece && isRegularReadFd(fd)) return readRegularPieces(fd, target, options.offset, options.length, at);
    const chunk = native.read(fd, options.length, at);
    target.set(chunk, options.offset);
    return chunk.length;
  }

  function readVectors(buffers) {
    if (!Array.isArray(buffers)) throw invalidArg("buffers", "an array", buffers);
    const views = [];
    for (const buffer of buffers) {
      if (!ArrayBuffer.isView(buffer)) throw invalidArg("buffers", "an array of ArrayBufferView instances", buffers);
      // Bun/Node submit at most IOV_MAX (1024) views, but validate the whole array.
      if (views.length === 1024) continue;
      views.push(internal.toUint8(buffer));
    }
    return views;
  }

  function readvPosition(position) {
    return Number.isSafeInteger(position) && position >= 0 ? position : -1;
  }

  function readVectorChunk(fd, length, position, progress) {
    try { return native.read(fd, length, position); } catch (error) {
      if (progress > 0) return null;
      throw error;
    }
  }

  function isRegularReadFd(fd) {
    try { return (native.fstat(fd).mode & constants.S_IFMT) === constants.S_IFREG; } catch {
      // Without metadata rights, conservatively use one bounded read, not a loop.
      return false;
    }
  }

  function boundedVectorLength(views) {
    let length = 0;
    for (const view of views) {
      length += Math.min(view.byteLength, 65536 - length);
      if (length === 65536) break;
    }
    return length;
  }

  function scatterRead(views, chunk) {
    let offset = 0;
    for (const view of views) {
      if (offset === chunk.length) break;
      const count = Math.min(view.byteLength, chunk.length - offset);
      view.set(chunk.subarray(offset, offset + count));
      offset += count;
    }
    return chunk.length;
  }

  function readRegularVector(fd, views, position) {
    let count = 0;
    for (const view of views) {
      if (view.byteLength === 0) continue;
      const chunk = readVectorChunk(fd, view.byteLength, position < 0 ? -1 : position + count, count);
      if (chunk === null) return count;
      view.set(chunk);
      count += chunk.length;
      if (chunk.length < view.byteLength) return count;
    }
    return count;
  }

  function readVectorViews(fd, views, position) {
    if (views.length === 0) return 0;
    const length = boundedVectorLength(views);
    // A nonempty all-empty vector still validates the real fd, without fstat.
    if (length === 0) return native.read(fd, 0, position).length;
    if (isRegularReadFd(fd)) return readRegularVector(fd, views, position);
    // Pipes/ttys/sockets must never issue a second potentially blocking read.
    return scatterRead(views, native.read(fd, length, position));
  }

  function readvSync(fd, buffers, position) {
    validateFd(fd);
    return readVectorViews(fd, readVectors(buffers), readvPosition(position));
  }

  function readvStdin(views, buffers, length, callback) {
    const target = new Uint8Array(length);
    return callbackApi.read(0, target, 0, length, null, (error, count) => {
      if (!error) scatterRead(views, target.subarray(0, count));
      callback(error, count, buffers);
    });
  }

  function readv(fd, buffers, position, callback) {
    if (typeof position === "function") { callback = position; position = null; }
    validateFd(fd);
    const views = readVectors(buffers);
    if (typeof callback !== "function") throw invalidArg("cb", "of type function", callback);
    const length = boundedVectorLength(views);
    // One bounded stdin read: after progress, never wait for another vector to fill.
    if (fd === 0 && native.hostCaps.proc_spawn && length > 0 && readvPosition(position) < 0 && !isRegularReadFd(fd)) return readvStdin(views, buffers, length, callback);
    let count = 0, error = null;
    try { count = readVectorViews(fd, views, readvPosition(position)); } catch (err) { error = err; }
    later(() => callback(error, count, buffers));
  }

  // Node's GetOffset (src/node_file.cc): only a non-negative safe integer is a file
  // position; NaN, Infinity, fractions, larger numbers and BigInts mean the current offset.
  function filePosition(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  }

  function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
    if (typeof data === "string") {
      const bytes = toBytes(data, typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8");
      return native.write(fd, bytes, filePosition(offsetOrPosition));
    }
    const view = internal.toUint8(data);
    const offset = offsetOrPosition || 0;
    const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : view.byteLength - offset;
    return native.write(fd, view.slice(offset, offset + length), filePosition(position));
  }

  function validateFd(fd) {
    if (typeof fd !== "number") throw invalidArg("fd", "of type number", fd);
    if (Number.isInteger(fd) && fd >= 0 && fd <= 2147483647) return;
    const expected = Number.isInteger(fd) ? ">= 0 && <= 2147483647" : "an integer";
    // A range error shows the number itself ("Received -1"), as Bun's does.
    const error = new RangeError(`The value of "fd" is out of range. It must be ${expected}. Received ${String(fd)}`);
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
    return native.writev(fd, buffers.map(internal.toUint8), filePosition(position));
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
    const release = pinArguments(1, [fd, buffers]);
    let written = 0;
    let error = null;
    try { written = writeBuffers(fd, buffers, position); } catch (err) { error = err; }
    later(() => {
      if (release !== null) release();
      callback(error, written, buffers);
    });
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
    openSync, closeSync, readSync, readvSync, writeSync, writevSync, globSync, opendirSync,
    statfsSync: (path) => internal.require("fs_statfs")(statSync, toPath)(path),
    fstatSync: (fd, options) => {
      validateFd(fd);
      return makeStats(native.fstat(fd, Boolean(options && options.bigint)), Boolean(options && options.bigint));
    },
    ftruncateSync: (fd, len) => native.ftruncate(fd, len || 0),
    truncateSync: (path, len) => withPath(path, (abs) => native.truncate(abs, len || 0)),
    readlinkSync: (path, options) => {
      encodingOf(options);
      return withPath(path, (abs) => native.readlink(abs));
    },
    symlinkSync: (target, path) => withPath(path, (abs) => native.symlink(toPath(target, "target"), abs)),
    linkSync: (from, to) => withPath(from, (abs) => native.link(abs, absolute(toPath(to, "newPath")))),
    chmodSync: (path) => void statSync(path),
    lchmodSync: noop,
    fchmodSync: noop,
    chownSync: (path) => void statSync(path),
    lchownSync: noop,
    fchownSync: noop,
    utimesSync: (path, atime, mtime) => setPathTimes(path, atime, mtime, false),
    lutimesSync: (path, atime, mtime) => setPathTimes(path, atime, mtime, true),
    futimesSync: (fd, atime, mtime) => {
      validateFd(fd);
      native.futimes(fd, ...timeSpec(atime, "atime"), ...timeSpec(mtime, "mtime"));
    },
    fsyncSync: noop,
    fdatasyncSync: noop,
  };

  // --- callback API -----------------------------------------------------------

  // Deliver on the "poll" phase: setImmediate keeps the loop alive until then.
  function later(fn) {
    internal.realTimers.setImmediate(fn);
  }

  // Bun keeps a Buffer path and the data a write reads attached until the call completes
  // (fs_buffer_pins.ts). The module loads on the first call that has bytes to pin.
  let bufferPins;
  const dataArguments = { write: 1, writev: 1, writeFile: 1, appendFile: 1 };
  const holdsBytes = (value) => typeof value === "object" && value !== null && (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || Array.isArray(value));
  // The release function, or null (allocating nothing) when neither the path nor the
  // data holds bytes, which is nearly every call.
  function pinArguments(dataIndex, args) {
    const path = args[0];
    const data = args[dataIndex];
    // Strings, numbers and undefined (nearly every call) need no further check.
    if (typeof path !== "object" && typeof data !== "object") return null;
    if (!holdsBytes(path) && !holdsBytes(data)) return null;
    bufferPins ??= internal.require("fs_buffer_pins");
    return bufferPins.pin([path, data]);
  }

  // The argument that holds readFile's, writeFile's and appendFile's options, path first.
  const optionsArguments = { readFile: 1, writeFile: 2, appendFile: 2 };
  const hasSignal = (options) => options !== null && typeof options === "object" && options.signal !== undefined;

  const argumentErrors = new Set(["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE"]);
  function callbackify(name, fn, shape) {
    const dataIndex = dataArguments[name] ?? 0;
    const signalIndex = optionsArguments[name] ?? -1;
    return function (...args) {
      const callback = args.pop();
      if (typeof callback !== "function") throw invalidArg("cb", "of type function", callback);
      if (signalIndex < 0 || !hasSignal(args[signalIndex])) return runCallback(fn, shape, dataIndex, args, callback);
      const helpers = abortable();
      helpers.callback(helpers.signalOf(args[signalIndex]), (done) => runCallback(fn, shape, dataIndex, args, done), callback);
    };
  }

  function runCallback(fn, shape, dataIndex, args, callback) {
    const release = pinArguments(dataIndex, args);
    let result;
    let error = null;
    try {
      result = fn.apply(undefined, args);
    } catch (err) {
      // Node validates arguments before queuing the operation, so those errors throw now.
      if (err && argumentErrors.has(err.code)) {
        if (release !== null) release();
        throw err;
      }
      error = err;
    }
    if (release === null) {
      later(() => (shape ? shape(callback, error, result, args) : callback(error, result)));
      return;
    }
    later(() => {
      release();
      if (shape) shape(callback, error, result, args);
      else callback(error, result);
    });
  }

  const callbackApi = {};
  for (const name of Object.keys(sync)) {
    callbackApi[name.slice(0, -4)] = callbackify(name.slice(0, -4), sync[name]);
  }
  // fs.exists(path, cb) passes only a boolean.
  callbackApi.exists = function exists(path, callback) {
    const result = existsSync(path);
    later(() => callback(result));
  };
  callbackApi.cp = cp;
  callbackApi.glob = glob;
  callbackApi.opendir = opendir;
  callbackApi.writev = writev;
  callbackApi.readv = readv;
  const readCallback = callbackify("read", readSync, (cb, err, n, args) => cb(err, n, args[1]));
  // runtime_proc reports negative WASI errnos, not the networking slot status codes.
  // Match the Node error names/errnos used by the synchronous filesystem natives.
  const stdinReadErrors = {
    2: ["EACCES", -13], 4: ["EADDRNOTAVAIL", -99], 8: ["EBADF", -9],
    21: ["EFAULT", -14], 27: ["EINTR", -4], 28: ["EINVAL", -22], 29: ["EIO", -5],
    31: ["EISDIR", -21], 48: ["ENOMEM", -12], 52: ["ENOSYS", -38], 58: ["ENOTSUP", -95],
    61: ["EOVERFLOW", -75], 63: ["EPERM", -1], 64: ["EPIPE", -32], 76: ["ENOTCAPABLE", undefined],
  };
  callbackApi.read = function (...args) {
    if (args[0] !== 0 || !native.hostCaps.proc_spawn) return readCallback(...args);
    const callback = args.pop();
    if (typeof callback !== "function") throw invalidArg("cb", "of type function", callback);
    const context = native.getAsyncContext();
    const complete = (...values) => internal.runInContext(context, callback, undefined, values);
    const [fd, buffer, offsetOrOptions, length, position] = args;
    const options = readOptions(buffer, offsetOrOptions, length, position);
    if (options.length === 0) return later(() => complete(null, 0, buffer));
    const step = () => {
      const chunk = native.procRead(fd, options.length);
      if (chunk === -6) return false; // WASI EAGAIN: leave the waiter registered.
      if (typeof chunk === "number" && chunk < 0) {
        const [code, errno] = stdinReadErrors[-chunk] || [`E${-chunk}`, undefined];
        throw Object.assign(new Error(`read ${code}`), { code, syscall: "read", errno });
      }
      if (chunk !== 0) internal.toUint8(buffer).set(chunk, options.offset);
      later(() => complete(null, chunk === 0 ? 0 : chunk.length, buffer));
      return true;
    };
    // One 16-byte runtime_proc subscription: u32 READABLE (0), u32 fd, u64 userdata.
    const subscription = new Uint8Array(16);
    new DataView(subscription.buffer).setUint32(4, fd, true);
    internal.require("net");
    internal.addIoWaiter({ step, subscriptions: () => subscription, fail: error => later(() => complete(error, 0, buffer)) });
  };
  callbackApi.write = callbackify("write", writeSync, (cb, err, n, args) => cb(err, n, args[1]));

  // --- promises ---------------------------------------------------------------

  function promisifySync(fn, name) {
    const dataIndex = dataArguments[name] ?? 0;
    return function (...args) {
      return new Promise((resolve, reject) => {
        const release = pinArguments(dataIndex, args);
        let result;
        try {
          result = fn.apply(undefined, args);
        } catch (err) {
          later(release === null ? () => reject(err) : () => {
            release();
            reject(err);
          });
          return;
        }
        later(release === null ? () => resolve(result) : () => {
          release();
          resolve(result);
        });
      });
    };
  }

  // AbortSignal options and iterable writeFile data (fs_abortable.ts), loaded on first use.
  let abortableModule;
  function abortable() {
    abortableModule ??= internal.require("fs_abortable")({
      openSync, closeSync, writeSync, ftruncateSync: sync.ftruncateSync, later,
      isEncoding: (encoding) => Buffer.isEncoding(encoding), encode: (chunk, encoding) => Buffer.from(chunk, encoding),
      describe: internal.describe,
    });
    return abortableModule;
  }
  // Only writeFile takes iterable data; strings and views never load the helper module.
  const mayIterate = (data) => data !== null && typeof data === "object" && !ArrayBuffer.isView(data);

  function wholeFilePromise(name, byPath) {
    const optionsIndex = optionsArguments[name] - 1;
    const iterates = name === "writeFile";
    const run = (path, args) => fileHandleModule?.isFileHandle(path) ? path[name](...args) : byPath(path, ...args);
    return function (path, ...args) {
      if ((iterates && mayIterate(args[0])) || hasSignal(args[optionsIndex])) return wholeFileSlowPath(run, path, args, args[optionsIndex]);
      return fileHandleModule?.isFileHandle(path) ? path[name](...args) : byPath(path, ...args);
    };
  }

  // An async function, so an invalid signal rejects instead of throwing.
  async function wholeFileSlowPath(run, path, args, options) {
    const helpers = abortable();
    if (mayIterate(args[0]) && helpers.isIterableData(args[0])) {
      return helpers.writeIterable(fileHandleModule?.isFileHandle(path) ? path.fd : path, args[0], options);
    }
    if (!hasSignal(options)) return run(path, args);
    return helpers.promise(helpers.signalOf(options), () => run(path, args));
  }

  // FileHandle#writeFile takes iterable data too, written from the handle's position.
  function writeHandleFile(fd, data, options) {
    if (mayIterate(data) && abortable().isIterableData(data)) return abortable().writeIterable(fd, data, options);
    return writeFileSync(fd, data, options);
  }

  let fileHandleModule;
  function fileHandles() {
    fileHandleModule ??= internal.require("fs_file_handle")({
      Buffer, closeSync, readFileSync, writeFileSync: writeHandleFile, appendFileSync, readSync, readvSync, writeSync, writevSync,
      fstatSync: sync.fstatSync, ftruncateSync: sync.ftruncateSync, later, createReadStream, createWriteStream,
    });
    return fileHandleModule;
  }

  const promises = {};
  for (const name of Object.keys(sync)) {
    promises[name.slice(0, -4)] = promisifySync(sync[name], name.slice(0, -4));
  }
  // The whole-file operations also take a FileHandle, which reads or writes at its
  // position, and an AbortSignal.
  for (const name of ["readFile", "writeFile", "appendFile"]) {
    promises[name] = wholeFilePromise(name, promises[name]);
  }
  promises.glob = async function* glob(pattern, options) { yield* globSync(pattern, options); };
  promises.open = async (path, flags, mode) => new (fileHandles().FileHandle)(openSync(path, flags, mode));
  promises.cp = async (from, to, options) => copyAsync(toPath(from, "src"), toPath(to, "dest"), options);
  promises.constants = constants;
  delete promises.close;
  delete promises.readv;
  delete promises.fstat;
  delete promises.ftruncate;

  // --- file streams over the existing descriptor and Node stream adapters -----

  let fileStreamAdapter;
  function fileStreams() {
    fileStreamAdapter ??= internal.require("fs_stream_constructors")({
      read: native.read, asBuffer, openSync, closeSync, writeSync, toPath, validateFd, readRange, invalidArg,
      isEncoding: (encoding) => Buffer.isEncoding(encoding), inspect: (value) => internal.require("inspect").nodeInspect(value),
      readPieceSize: kReadPiece, isRegularReadFd, later, linkHandle: (value, onClose) => fileHandleModule?.linkStream(value, onClose),
      loadStreams: () => internal.builtin("node:stream"),
    });
    return fileStreamAdapter;
  }

  function createReadStream(path, options) {
    return fileStreams().createReadStream(path, options);
  }

  function createWriteStream(path, options) {
    return fileStreams().createWriteStream(path, options);
  }

  function readStreamConstructor() {
    const adapter = fileStreams();
    adapter.initializeFileStreams();
    return adapter.ReadStream;
  }

  function writeStreamConstructor() {
    const adapter = fileStreams();
    adapter.initializeFileStreams();
    return adapter.WriteStream;
  }

  function watchUnsupported() {
    throw Object.assign(new Error("fs.watch is not supported in bun-wasm"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
  }

  const { watch, FSWatcher } = internal.require("fs_watch")({ statSync, toPath, absolute });
  promises.watch = (path, options) => internal.require("fs_promises_watch")(watch, toPath)(path, options);
  const fs = Object.assign({}, sync, callbackApi, {
    promises,
    constants,
    Stats,
    Dirent,
    Dir,
    createReadStream,
    createWriteStream,
    watch,
    FSWatcher,
    watchFile: watchUnsupported,
    unwatchFile: () => {},
    // Bun's src/js/node/fs.ts: a lazily read Bun.file Blob.
    openAsBlob: function openAsBlob(path, options) {
      return Promise.resolve(internal.builtin("bun").file(path, options));
    },
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
  });

  Object.defineProperties(fs, {
    ReadStream: { get: readStreamConstructor, enumerable: true, configurable: true },
    WriteStream: { get: writeStreamConstructor, enumerable: true, configurable: true },
    FileReadStream: { get: readStreamConstructor, enumerable: true, configurable: true },
    FileWriteStream: { get: writeStreamConstructor, enumerable: true, configurable: true },
  });
  return { fs, promises };
})
