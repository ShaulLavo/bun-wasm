// The `Bun` global (also the "bun" module).
(function (internal) {
  "use strict";
  const native = internal.native;
  const { Blob, Response, Request, TextDecoder } = internal.web;
  const info = native.platformInfo;

  function unsupported(name, why) {
    return function () {
      const err = new Error(`${name} is not supported in bun-wasm: ${why}`);
      err.code = "ERR_NOT_SUPPORTED_IN_WASM";
      throw err;
    };
  }

  function toPath(target) {
    if (target instanceof URL) return decodeURIComponent(target.pathname);
    const str = String(target);
    if (str.startsWith("file://")) return decodeURIComponent(new URL(str).pathname);
    return str;
  }

  function absolute(path) {
    if (path.startsWith("/")) return path;
    const cwd = native.cwd();
    return (cwd === "/" ? "" : cwd) + "/" + path;
  }

  // Bun.FetchSession: in Bun, fetch() over the session's own connections. The host keeps one
  // shared set of connections, so a session's fetch() is fetch() and close() has nothing to release.
  class FetchSession {
    fetch(_input) {
      return Reflect.apply(internal.web.fetch, undefined, arguments);
    }
    close() {}
    get [Symbol.toStringTag]() {
      return "FetchSession";
    }
  }

  // Bun.file(): a lazily read Blob backed by a path or a file descriptor.
  class BunFile extends Blob {
    #path;
    #nullName = false;
    #fd;
    #start;
    #end;
    constructor(target, options = {}, key = undefined, range = undefined) {
      super([], options);
      if (key !== internal) throw new TypeError("BunFile is not constructable; use Bun.file()");
      if (typeof target === "number") {
        this.#fd = internal.require("bun_file").validateDescriptor(target);
        this.#path = null;
      } else {
        this.#path = toPath(target);
        this.#fd = null;
      }
      this.#start = range ? range[0] : 0;
      this.#end = range ? range[1] : undefined;
      if (!options.type && this.#path) this._setType(internal.mimeType(this.#path));
      else if (!options.type) this._setType("application/octet-stream");
    }
    // A name the caller set, else the path, as Bun's get_name_string does. Set to null, it is
    // null.
    get name() {
      if (this.#nullName) return null;
      const name = super.name;
      if (name !== undefined) return name;
      return this.#path === null ? undefined : this.#path;
    }
    set name(value) {
      this.#nullName = value === null;
      super.name = value;
    }
    get fd() {
      return this.#fd;
    }
    _isLazy() {
      return true;
    }
    // A file given by descriptor (Bun.stdin included) can be read only once: a second read
    // starts where the first stopped. Bodies sharing it share that one read, as Bun tees it.
    _readsOnce() {
      return this.#fd !== null;
    }
    _bytes() {
      try {
        if (this.#fd === 0 && this.#start === 0 && this.#end === undefined) return native.readStdin();
        if (this.#path !== null && this.#start === 0 && this.#end === undefined) return native.readFile(absolute(this.#path));
        return internal.require("bun_file").bytes(this.#fd !== null ? this.#fd : absolute(this.#path), this.#start, this.#end);
      } catch (error) {
        throw this.#directoryError(error);
      }
    }
    // Bun reports reading a directory as EISDIR, where opening one under WASI gives EBADF.
    #directoryError(error) {
      if (!error || (error.code !== "EBADF" && error.code !== "EISDIR")) return error;
      return this.#isDirectory() ? this.#readsDirectory() : error;
    }
    #isDirectory() {
      try { return (this.#stat().mode & 0o170000) === 0o040000; } catch { return false; }
    }
    #readsDirectory() {
      const directory = Object.assign(new Error("Directories cannot be read like files"), { code: "EISDIR", errno: 0, syscall: "read" });
      if (this.#path !== null) directory.path = this.#path;
      return directory;
    }
    // A stream over a file opened by path remembers the file, so a body built from it can lift
    // the file back out. Bun tees a stream over a descriptor, which can only be read once; over
    // a directory it fails with Bun's EISDIR, as a read does.
    stream() {
      if (this.#fd !== null && this.#isDirectory()) {
        const error = this.#readsDirectory();
        return new ReadableStream({ start(controller) { controller.error(error); } });
      }
      if (this.#fd !== null) return internal.require("bun_file").stream(this.#fd, this.#start, this.#end);
      const stream = internal.require("bun_file").stream(absolute(this.#path), this.#start, this.#end);
      return internal.require("body_streams").rememberFile(stream, this);
    }
    #stat() {
      return this.#fd !== null ? native.fstat(this.#fd) : native.stat(absolute(this.#path));
    }
    // The size of this view of the file now, or null when the file cannot be stat'ed. As in
    // Bun, a device or pipe (and anything but a regular file behind a descriptor) is Infinity.
    _knownSize() {
      let stat;
      try { stat = this.#stat(); } catch { return null; }
      const kind = stat.mode & 0o170000;
      if (kind !== 0o100000 && (this.#fd !== null || kind !== 0o040000)) return Infinity;
      const end = this.#end === undefined ? stat.size : Math.min(this.#end, stat.size);
      return Math.max(0, end - this.#start);
    }
    // A bounded slice of a file that cannot be stat'ed still has its length, as in Bun.
    get size() {
      const known = this._knownSize();
      if (known !== null) return known;
      return this.#end === undefined ? 0 : Math.max(0, this.#end - this.#start);
    }
    get lastModified() {
      try {
        return (this.#fd !== null ? native.fstat(this.#fd) : native.stat(absolute(this.#path))).mtimeMs;
      } catch {
        return 0;
      }
    }
    async exists() {
      if (this.#fd === null) return native.exists(absolute(this.#path));
      try { return (native.fstat(this.#fd).mode & 0o170000) === 0o100000; }
      catch (err) { if (err.code === "EBADF") return false; throw err; }
    }
    async stat() {
      const fs = internal.builtin("node:fs");
      return this.#fd !== null ? fs.fstatSync(this.#fd) : fs.statSync(absolute(this.#path));
    }
    async write(data) {
      return writeTo(this, data);
    }
    async delete() {
      native.unlink(absolute(this.#path));
    }
    async unlink() {
      return this.delete();
    }
    // Bun's Blob.slice bounds over the file's size now (Bun's largest Blob size when it is not
    // known); without a valid type of its own the slice keeps the file's.
    slice(...args) {
      const known = this._knownSize();
      const size = known === null || !Number.isFinite(known) ? 2 ** 52 - 1 : known;
      const { start, length, type } = internal.sliceBounds(args, size);
      const [given, interned] = internal.blobType(type);
      const from = this.#start + start;
      const slice = new BunFile(this.#fd !== null ? this.#fd : this.#path, {}, internal, [from, from + length]);
      // The type is already Bun's; the constructor would normalize it again.
      slice._setType(given || this.type, given ? interned : false);
      return slice;
    }
    writer() {
      const path = this.#path;
      const fd = this.#fd;
      if (path !== null) native.writeFile(absolute(path), "", false);
      let written = 0;
      return {
        write(chunk) {
          const bytes = typeof chunk === "string" ? native.utf8Encode(chunk) : internal.toUint8(chunk);
          if (fd !== null) native.write(fd, bytes);
          else native.writeFile(absolute(path), bytes, true);
          written += bytes.length;
          return bytes.length;
        },
        flush: () => written,
        end: () => written,
        ref() {},
        unref() {},
      };
    }
    get [Symbol.toStringTag]() {
      return "BunFile";
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      const name = this.#path === null ? `fd ${this.#fd}` : `"${this.#path}"`;
      return `FileRef (${name}) {\n  type: "${this.type}"\n}`;
    }
  }

  function file(target, options) {
    if (target instanceof BunFile) return target;
    return new BunFile(target, options, internal);
  }

  async function dataBytes(data) {
    if (data instanceof internal.require("archive").Archive) return data.bytes();
    if (data instanceof Response || data instanceof Request) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof Blob) return data._bytes();
    if (typeof data === "string") return native.utf8Encode(data);
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data);
    if (Array.isArray(data)) return new Uint8Array(await new Blob(data).arrayBuffer());
    return native.utf8Encode(String(data));
  }

  async function writeTo(dest, data) {
    const bytes = await dataBytes(data);
    if (typeof dest === "number") return native.write(dest, bytes);
    if (dest instanceof BunFile && dest.fd !== null) return native.write(dest.fd, bytes);
    const path = absolute(dest instanceof BunFile ? dest.name : toPath(dest));
    try {
      return native.writeFile(path, bytes, false);
    } catch (err) {
      // Bun.write creates missing parent directories.
      if (err.code !== "ENOENT") throw err;
      native.mkdir(internal.dirname(path), true);
      return native.writeFile(path, bytes, false);
    }
  }

  function write(dest, data) {
    if (typeof dest === "number") internal.require("bun_file").validateDescriptor(dest);
    return writeTo(dest, data);
  }

  function sleep(ms) {
    const delay = ms instanceof Date ? ms.getTime() - Date.now() : Number(ms);
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
  }

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
  const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

  function stripANSI(str) {
    return String(str).replace(ANSI_RE, "");
  }

  // East Asian Wide/Fullwidth and emoji ranges (abridged from Unicode's
  // EastAsianWidth.txt); combining marks and controls are zero width.
  const WIDE = [
    [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
    [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
    [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
    [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
    [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
    [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
    [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
    [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
    [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
    [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393],
    [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e],
    [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
    [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5],
    [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec],
    [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
    [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
  ];

  function isWide(cp) {
    let lo = 0;
    let hi = WIDE.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < WIDE[mid][0]) hi = mid - 1;
      else if (cp > WIDE[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  }

  function isZeroWidth(cp) {
    return (
      cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x2060 || cp === 0xfeff ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0000 && cp <= 0xe007f)
    );
  }

  function stringWidth(str, options = {}) {
    const text = options.countAnsiEscapeCodes ? String(str) : stripANSI(str);
    const ambiguousIsNarrow = options.ambiguousIsNarrow !== false;
    void ambiguousIsNarrow;
    let width = 0;
    let previousZwj = false;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0x200d) {
        previousZwj = true;
        continue;
      }
      if (previousZwj) {
        // Joined emoji sequences render as one glyph.
        previousZwj = false;
        continue;
      }
      if (isZeroWidth(cp)) continue;
      width += isWide(cp) ? 2 : 1;
    }
    return width;
  }

  function hash(data) {
    const [high, low] = seedWords(arguments[1]);
    return native.wyhash(hashData(data), high, low);
  }

  // HashObject.rs hash_wrap: strings hash as UTF-8, buffers and in-memory Blobs as their bytes,
  // other values as their string form; a missing value or a file-backed Blob is an error.
  function hashData(data) {
    if (typeof data === "string") return native.utf8Encode(data);
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data).slice();
    if (data instanceof Blob) {
      if (data._isLazy()) throw Object.assign(new TypeError("File blob cannot be used here"), { code: "ERR_INVALID_ARG_TYPE" });
      return data._bytes();
    }
    if (data === undefined || data === null) {
      throw Object.assign(new TypeError("data must be a string, ArrayBuffer, ArrayBufferView or Blob"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    return native.utf8Encode(String(data));
  }

  function hashInput(data) {
    if (typeof data === "string") return data;
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data).slice();
    return String(data);
  }

  // Bun.gzipSync/gunzipSync/deflateSync/inflateSync (BunObject.rs JSZlib) with
  // zlib: Bun's errors carry only zlib's message.
  function bunZlib(data, options, mode) {
    const settings = options && typeof options === "object" ? options : {};
    const config = { level: settings.level ?? -1, windowBits: settings.windowBits ?? 15, memLevel: settings.memLevel ?? 8, strategy: settings.strategy ?? 0 };
    try {
      return native.zlibConvert(hashInput(data), mode, JSON.stringify(config), undefined, 4, 64 * 1024, 2 ** 32);
    } catch (error) {
      if (error && typeof error === "object" && "errno" in error) throw new Error(error.message);
      throw error;
    }
  }

  // HashObject.rs reads a number or bigint seed with JSC's toUInt64NoTruncate, as measured on
  // native Bun: a bigint wraps to 64 bits; a finite number truncates and wraps (so any negative
  // number wraps too, and -2^64 is 0) but saturates at u64 max from 2^64 up and at Infinity;
  // NaN, -Infinity and any other value are 0. Returns the seed as [high, low] 32-bit words.
  const U64_MAX = 2n ** 64n - 1n;
  function hashSeed(seed) {
    if (typeof seed === "bigint") return BigInt.asUintN(64, seed);
    if (typeof seed !== "number" || Number.isNaN(seed) || seed === -Infinity) return 0n;
    if (seed >= 2 ** 64) return U64_MAX;
    return BigInt.asUintN(64, BigInt(Math.trunc(seed)));
  }
  function seedWords(seed) {
    const value = hashSeed(seed);
    return [Number(value >> 32n), Number(value & 0xffffffffn)];
  }

  hash.wyhash = hash;
  // crc32 continues from a u32 seed; adler32 has none, as in Bun.
  hash.crc32 = function crc32(data) { return native.crc32(hashData(data), seedWords(arguments[1])[1]); };
  hash.adler32 = function adler32(data) { return native.adler32(hashData(data)); };
  for (const name of ["cityHash32", "cityHash64", "xxHash32", "xxHash64", "xxHash3", "murmur32v2", "murmur32v3", "murmur64v2", "rapidhash"]) {
    hash[name] = {
      [name](data) {
        const [high, low] = seedWords(arguments[1]);
        return native.bunHash(name, hashData(data), high, low);
      },
    }[name];
  }

  const digests = internal.require("node_digest");

  class CryptoHasher {
    #algorithm;
    #chunks = [];
    #key;
    constructor(algorithm, hmacKey) {
      const name = digests.hasherName(String(algorithm));
      if (name === undefined) throw Object.assign(new TypeError(`Unsupported algorithm ${algorithm}`), { code: "ERR_INVALID_ARG_TYPE" });
      if (hmacKey !== undefined && !digests.hasherHmac(name)) throw Object.assign(new Error("HMAC is not supported for this algorithm yet"), { name: "TODOError" });
      this.#algorithm = name;
      this.#key = hmacKey === undefined ? null : hmacKey;
    }
    get algorithm() {
      return this.#algorithm;
    }
    get byteLength() {
      return digests.byteLength(this.#algorithm);
    }
    update(data, encoding) {
      const B = internal.require("buffer").Buffer;
      this.#chunks.push(typeof data === "string" ? B.from(data, encoding) : internal.toUint8(data).slice());
      return this;
    }
    digest(encoding) {
      const input = internal.concatBytes(this.#chunks);
      // Digesting resets the hasher, as in Bun.
      this.#chunks = [];
      const bytes = this.#key === null ? native.nodeDigest(this.#algorithm, input) : native.nodeHmac(this.#algorithm, hashInput(this.#key), input);
      const B = internal.require("buffer").Buffer;
      const buf = B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (encoding === undefined) return buf;
      if (ArrayBuffer.isView(encoding)) {
        encoding.set(bytes);
        return encoding;
      }
      return buf.toString(encoding);
    }
    copy() {
      const copy = new CryptoHasher(this.#algorithm, this.#key === null ? undefined : this.#key);
      for (const c of this.#chunks) copy.update(c);
      return copy;
    }
    static hash(algorithm, data, encoding) {
      return new CryptoHasher(algorithm).update(data).digest(encoding);
    }
  }
  // A fresh array per read, as in Bun.
  Object.defineProperty(CryptoHasher, "algorithms", { get: () => digests.hasherAlgorithms.slice(), enumerable: true });

  function randomUUIDv7(encoding, timestamp) {
    const ms = BigInt(timestamp === undefined ? Date.now() : Number(timestamp));
    const bytes = native.randomBytes(16);
    for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    if (encoding === "buffer") return internal.require("buffer").Buffer.from(bytes);
    const h = internal.hex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function peek(promise) {
    if (!(promise instanceof Promise)) return promise;
    return native.promiseState(promise) === "pending" ? promise : native.promiseResult(promise);
  }
  peek.status = (promise) => (promise instanceof Promise ? native.promiseState(promise) : "fulfilled");

  function inspect(value, options, colors) {
    return internal.require("inspect").bunInspect(value, options, colors);
  }
  inspect.custom = Symbol.for("nodejs.util.inspect.custom");
  inspect.table = (data, columns) => {
    let captured = "";
    const original = native.writeStdout;
    try {
      native.writeStdout = (s) => (captured += s);
      globalThis.console.table(data, columns);
    } finally {
      native.writeStdout = original;
    }
    return captured;
  };

  function resolveSync(spec, from) {
    const base = from === undefined ? native.cwd() + "/" : String(from);
    // A directory (no extension, existing dir) resolves relative to itself.
    const fromPath = !base.endsWith("/") && native.exists(base) && native.stat(base).mode & 0o040000 ? base + "/" : base;
    return native.resolve(String(spec), fromPath, false);
  }

  // Bun.build(): Bun's bundler (native.build). Outputs are BuildArtifacts, Blobs with a path.
  class BuildArtifact extends Blob {
    constructor(output, entrypoints) {
      const kind = output.kind;
      const type = kind === "sourcemap" || kind === "metafile" ? "application/json;charset=utf-8" : internal.mimeType(output.path);
      super([output.contents], { type });
      this.path = output.path;
      this.kind = kind;
      this.loader = /\.css$/.test(output.path) ? "css" : kind === "sourcemap" || kind === "metafile" ? "json" : entryLoader(output, entrypoints);
      this.hash = null;
      this.sourcemap = null;
    }
  }

  // An entry point's loader is its source's (`tsx` for App.tsx -> App.js), like Bun's.
  function entryLoader(output, entrypoints) {
    if (output.kind === "asset") return "file";
    if (output.kind !== "entry-point") return "js";
    const stem = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
    const source = entrypoints.find((e) => stem(e) === stem(output.path));
    const ext = source ? source.slice(source.lastIndexOf(".") + 1) : "js";
    return { mjs: "js", cjs: "js", mts: "ts", cts: "ts" }[ext] || ext;
  }

  const BUILD_STRINGS = ["outdir", "root", "target", "format", "packages", "publicPath", "banner", "footer"];
  const BUILD_FLAGS = ["splitting", "reactFastRefresh"];

  function buildLog(message, level) {
    return { name: "BuildMessage", level, message, position: null, notes: [], toString: () => message };
  }

  async function build(config) {
    if (!config || typeof config !== "object") throw new TypeError("Bun.build expects an options object");
    const { resolve } = internal.require("path");
    const entrypoints = Array.from(config.entrypoints || [], (e) => resolve(toPath(e)));
    if (entrypoints.length === 0) throw new TypeError("Bun.build: expected a non-empty array of entrypoints");
    // The native bundler has no JavaScript plugin hooks yet; ignoring a plugin would build the wrong output.
    if (Array.isArray(config.plugins) && config.plugins.length) {
      unsupported("Bun.build({ plugins })", "the bundler has no JavaScript plugin hooks yet")();
    }
    const request = { entrypoints };
    for (const key of BUILD_STRINGS) if (config[key] !== undefined) request[key] = String(config[key]);
    for (const key of BUILD_FLAGS) if (config[key]) request[key] = true;
    if (request.outdir) request.outdir = resolve(request.outdir);
    if (request.root) request.root = resolve(request.root);
    if (Array.isArray(config.external)) request.external = config.external.map(String);
    if (config.conditions !== undefined) request.conditions = [].concat(config.conditions).map(String);
    if (config.define) request.define = Object.fromEntries(Object.entries(config.define).map(([k, v]) => [k, String(v)]));
    const minify = config.minify;
    if (minify === true) Object.assign(request, { minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: true });
    else if (minify && typeof minify === "object") {
      Object.assign(request, { minifySyntax: !!minify.syntax, minifyWhitespace: !!minify.whitespace, minifyIdentifiers: !!minify.identifiers });
    }
    const sourcemap = config.sourcemap;
    if (sourcemap !== undefined && sourcemap !== false) request.sourcemap = sourcemap === true ? "linked" : String(sourcemap);
    const naming = config.naming;
    if (typeof naming === "string") request.entryNaming = naming;
    else if (naming && typeof naming === "object") {
      if (naming.entry) request.entryNaming = String(naming.entry);
      if (naming.chunk) request.chunkNaming = String(naming.chunk);
      if (naming.asset) request.assetNaming = String(naming.asset);
    }
    // Bun.build names shared chunks `chunk-<hash>` (the CLI uses the entry's name).
    if (!request.chunkNaming) request.chunkNaming = "./chunk-[hash].[ext]";
    let result;
    try {
      result = native.build(JSON.stringify(request));
    } catch (err) {
      const message = String((err && err.message) || err);
      const logs = [buildLog(message, "error")];
      if (config.throw === false) return { success: false, outputs: [], logs };
      throw new AggregateError(logs, message ? `Bundle failed\n${message}` : "Bundle failed");
    }
    const logs = result.logs ? [buildLog(result.logs.trimEnd(), "warning")] : [];
    return { success: true, outputs: result.outputs.map((o) => new BuildArtifact(o, entrypoints)), logs };
  }

  const concatArrayBuffers = internal.require("concat_array_buffers");

  async function readableStreamToBytes(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(typeof chunk === "string" ? native.utf8Encode(chunk) : internal.toUint8(chunk));
    return internal.concatBytes(chunks);
  }

  const noProcesses = "WASI has no processes";
  const noNetwork = "WASI has no network access";

  const { TOML, YAML, JSON5, JSONC } = internal.require("formats");
  const { Glob } = internal.require("glob");
  const { Cookie, CookieMap } = internal.require("cookie");
  const { ArrayBufferSink } = internal.require("array_buffer_sink");
  function semverString(value) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    return `${value}`;
  }
  const semver = {
    satisfies(version, range) {
      if (arguments.length < 2) throw new Error("Expected two arguments");
      return native.semverSatisfies(semverString(version), semverString(range));
    },
    order(left, right) {
      if (arguments.length < 2) throw new Error("Expected two arguments");
      return native.semverOrder(semverString(left), semverString(right));
    },
  };

  const forceColor = globalThis.process.env.FORCE_COLOR;
  const enableANSIColors = forceColor !== undefined
    ? forceColor !== "0"
    : globalThis.process.env.NO_COLOR === undefined && native.isatty(2);

  const dns = internal.require("dns");

  const Bun = {
    ArrayBufferSink,
    Archive: internal.require("archive").Archive,

    jest: () => internal.require("bun_test").exports,
    semver,
    TOML, YAML, JSON5, JSONC, Glob, Cookie, CookieMap, JSONL: internal.require("jsonl"),
    version: info.version,
    revision: info.revision,
    version_with_sha: `v${info.version} (${info.revision.slice(0, 9)})`,
    Transpiler: internal.require("bun_transpiler").Transpiler,
    get argv() {
      return globalThis.process.argv;
    },
    get env() {
      return globalThis.process.env;
    },
    get main() {
      return internal.mainPath;
    },
    file,
    write,
    sleep,
    sleepSync: (ms) => native.sleep(Number(ms)),
    nanoseconds: () => Math.floor(native.nanoseconds()),
    inspect,
    deepEquals: (a, b, strict) => internal.require("util").bunDeepEquals(a, b, Boolean(strict)),
    // Named parameters keep Bun's length of 2; the count is passed for its two-value check.
    deepMatch: function deepMatch(subset, object) { return internal.require("bun_deep_match")(arguments.length, subset, object); },
    escapeHTML,
    stringWidth,
    stripANSI,
    which: (command, options) => internal.require("spawn").which(command, options),
    hash,
    CryptoHasher,
    get password() { return internal.require("bun_password").password; },
    // Bun.sha is SHA-512/256, as in Bun.
    sha: function sha(input) { return internal.require("bun_hash_classes").SHA512_256.hash(input, arguments[1]); },
    // Loaded on first use; the module is cached, so each class keeps one identity.
    get MD4() { return internal.require("bun_hash_classes").MD4; },
    get MD5() { return internal.require("bun_hash_classes").MD5; },
    get SHA1() { return internal.require("bun_hash_classes").SHA1; },
    get SHA224() { return internal.require("bun_hash_classes").SHA224; },
    get SHA256() { return internal.require("bun_hash_classes").SHA256; },
    get SHA384() { return internal.require("bun_hash_classes").SHA384; },
    get SHA512() { return internal.require("bun_hash_classes").SHA512; },
    get SHA512_256() { return internal.require("bun_hash_classes").SHA512_256; },
    randomUUIDv7,
    peek,
    // Bun returns the heap size the collection measured, which heapUsed then reports.
    gc: () => {
      const measured = native.gc();
      return typeof measured === "number" ? measured : native.memoryUsage().heapUsed ?? 0;
    },
    plugin: internal.require("bun_plugin").plugin,
    resolveSync,
    resolve: async (spec, from) => resolveSync(spec, from),
    fileURLToPath: (url) => internal.require("node_url").fileURLToPath(url),
    pathToFileURL: (path) => internal.require("node_url").pathToFileURL(path),
    concatArrayBuffers,
    gzipSync: (data, options) => bunZlib(data, options, "gzip"),
    gunzipSync: (data, options) => bunZlib(data, options, "gunzip"),
    deflateSync: (data, options) => bunZlib(data, options, "deflateRaw"),
    inflateSync: (data, options) => bunZlib(data, options, "inflateRaw"),
    zstdCompressSync: (data, options) => internal.require("zlib").bunCompress(data, options),
    zstdDecompressSync: (data) => internal.require("zlib").bunDecompress(data),
    zstdCompress: (data, options) => Promise.resolve(internal.require("zlib").bunCompress(data, options)),
    zstdDecompress: (data) => new Promise(resolve => resolve(internal.require("zlib").bunDecompress(data))),
    readableStreamToBytes,
    readableStreamToArrayBuffer: async (s) => (await readableStreamToBytes(s)).buffer,
    readableStreamToText: async (s) => new TextDecoder().decode(await readableStreamToBytes(s)),
    readableStreamToJSON: async (s) => JSON.parse(new TextDecoder().decode(await readableStreamToBytes(s))),
    readableStreamToBlob: async (s) => new Blob([await readableStreamToBytes(s)]),
    readableStreamToArray: (stream) => internal.require("readable_stream_methods").readableStreamToArray(stream),
    isMainThread: true,
    enableANSIColors,
    get stdout() {
      return file(1);
    },
    get stderr() {
      return file(2);
    },
    get stdin() {
      return file(0);
    },
    spawn: (cmd, options) => internal.require("spawn").spawn(cmd, options),
    spawnSync: (cmd, options) => internal.require("spawn").spawnSync(cmd, options),
    unsafe: {
      arrayBufferToString: unsupported("Bun.unsafe.arrayBufferToString", "zero-copy strings are not exposed"),
    },
    get $() {
      return internal.require("bun_shell").$;
    },
    build,
    // Its own function, as in Bun: it stays the original when application code replaces globalThis.fetch.
    fetch: function fetch(_input) {
      return Reflect.apply(internal.web.fetch, undefined, arguments);
    },
    FetchSession,
    serve: native.hostCaps.listen ? (options) => internal.require("net").serve(options) : unsupported("Bun.serve", noNetwork),
    listen: (options) => internal.require("net").bunTcp().listen(options),
    connect: (options) => internal.require("net").bunTcp().connect(options),
    udpSocket: unsupported("Bun.udpSocket", noNetwork),
    dns: dns.bun(),
    openInEditor: unsupported("Bun.openInEditor", noProcesses),
  };
  internal.BunFile = BunFile;
  Object.defineProperty(Bun, Symbol.toStringTag, { value: "Bun", configurable: true });
  return Bun;
})
