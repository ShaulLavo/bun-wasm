// The `Bun` global (also the "bun" module).
(function (internal) {
  "use strict";
  const native = internal.native;
  const { Blob, Response } = internal.web;
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

  // Bun.file(): a lazily read Blob backed by a path or a file descriptor.
  class BunFile extends Blob {
    #path;
    #fd;
    #start;
    #end;
    constructor(target, options = {}, key = undefined, range = undefined) {
      super([], options);
      if (key !== internal) throw new TypeError("BunFile is not constructable; use Bun.file()");
      if (typeof target === "number") {
        this.#fd = target;
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
    get name() {
      return this.#path === null ? undefined : this.#path;
    }
    get fd() {
      return this.#fd;
    }
    _bytes() {
      const bytes = this.#fd === 0 ? native.readStdin() : native.readFile(absolute(this.#path));
      if (this.#start === 0 && this.#end === undefined) return bytes;
      return bytes.subarray(this.#start, this.#end);
    }
    get size() {
      if (this.#fd !== null) return Infinity;
      try {
        const total = native.stat(absolute(this.#path)).size;
        const end = this.#end === undefined ? total : Math.min(this.#end, total);
        return Math.max(0, end - this.#start);
      } catch {
        return 0;
      }
    }
    get lastModified() {
      try {
        return native.stat(absolute(this.#path)).mtimeMs;
      } catch {
        return 0;
      }
    }
    async exists() {
      return this.#path !== null && native.exists(absolute(this.#path));
    }
    async text() {
      return native.utf8Decode(this._bytes());
    }
    async stat() {
      return internal.builtin("node:fs").statSync(absolute(this.#path));
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
    slice(start = 0, end = undefined, type = undefined) {
      const opts = { type: type === undefined ? this.type : type };
      return new BunFile(this.#fd !== null ? this.#fd : this.#path, opts, internal, [this.#start + start, end === undefined ? this.#end : this.#start + end]);
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
    if (data instanceof Response) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof Blob) return data._bytes();
    if (typeof data === "string") return native.utf8Encode(data);
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data);
    if (Array.isArray(data)) return new Uint8Array(await new Blob(data).arrayBuffer());
    return native.utf8Encode(String(data));
  }

  async function writeTo(dest, data) {
    const bytes = await dataBytes(data);
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

  function hash(data, seed = 0) {
    return native.wyhash(hashInput(data), Number(seed));
  }

  function hashInput(data) {
    if (typeof data === "string") return data;
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return internal.toUint8(data).slice();
    return String(data);
  }

  hash.wyhash = hash;
  hash.crc32 = (data) => native.crc32(hashInput(data));
  hash.adler32 = (data) => native.adler32(hashInput(data));
  for (const name of ["cityHash32", "cityHash64", "xxHash32", "xxHash64", "xxHash3", "murmur32v2", "murmur32v3", "murmur64v2", "rapidhash"]) {
    hash[name] = unsupported(`Bun.hash.${name}`, "only wyhash, crc32 and adler32 are implemented");
  }

  class CryptoHasher {
    #algorithm;
    #chunks = [];
    #key;
    constructor(algorithm, hmacKey) {
      this.#algorithm = String(algorithm).toLowerCase();
      this.#key = hmacKey === undefined ? null : hmacKey;
      if (native.hash(this.#algorithm, "") === undefined) throw new TypeError(`Unsupported algorithm ${algorithm}`);
    }
    get algorithm() {
      return this.#algorithm;
    }
    update(data, encoding) {
      const B = internal.require("buffer").Buffer;
      this.#chunks.push(typeof data === "string" ? B.from(data, encoding) : internal.toUint8(data).slice());
      return this;
    }
    digest(encoding) {
      const input = internal.concatBytes(this.#chunks);
      const bytes = this.#key === null ? native.hash(this.#algorithm, input) : native.hmac(this.#algorithm, hashInput(this.#key), input);
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
  CryptoHasher.algorithms = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];

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

  function inspect(value, options) {
    return internal.require("inspect").bunInspect(value, options);
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

  function concatArrayBuffers(buffers, maxLength, asUint8Array) {
    let bytes = internal.concatBytes(buffers.map((b) => internal.toUint8(b)));
    if (maxLength !== undefined) bytes = bytes.subarray(0, maxLength);
    return asUint8Array ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

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

  const Bun = {
    semver,
    TOML, YAML, JSON5, JSONC, Glob, Cookie, CookieMap, JSONL: internal.require("jsonl"),
    version: info.version,
    revision: info.revision,
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
    deepMatch: (subset, object) => internal.require("util").bunDeepEquals(subset, object, false, true),
    escapeHTML,
    stringWidth,
    stripANSI,
    which: () => null,
    hash,
    CryptoHasher,
    randomUUIDv7,
    peek,
    gc: () => native.gc(),
    resolveSync,
    resolve: async (spec, from) => resolveSync(spec, from),
    fileURLToPath: (url) => internal.require("node_url").fileURLToPath(url),
    pathToFileURL: (path) => internal.require("node_url").pathToFileURL(path),
    concatArrayBuffers,
    gzipSync: (data, options) => native.compress(hashInput(data), options && options.level !== undefined ? options.level : -1, "gzip"),
    gunzipSync: (data) => native.decompress(hashInput(data), "gzip"),
    deflateSync: (data, options) => native.compress(hashInput(data), options && options.level !== undefined ? options.level : -1, "raw"),
    inflateSync: (data) => native.decompress(hashInput(data), "raw"),
    readableStreamToBytes,
    readableStreamToArrayBuffer: async (s) => (await readableStreamToBytes(s)).buffer,
    readableStreamToText: async (s) => native.utf8Decode(await readableStreamToBytes(s)),
    readableStreamToJSON: async (s) => JSON.parse(native.utf8Decode(await readableStreamToBytes(s))),
    readableStreamToBlob: async (s) => new Blob([await readableStreamToBytes(s)]),
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
      gcAggressionLevel: unsupported("Bun.unsafe.gcAggressionLevel", "engine GC scheduling is not exposed"),
      arrayBufferToString: unsupported("Bun.unsafe.arrayBufferToString", "zero-copy strings are not exposed"),
    },
    $: unsupported("Bun.$", noProcesses),
    build,
    serve: native.hostCaps.listen ? (options) => internal.require("net").serve(options) : unsupported("Bun.serve", noNetwork),
    listen: unsupported("Bun.listen", noNetwork),
    connect: unsupported("Bun.connect", noNetwork),
    udpSocket: unsupported("Bun.udpSocket", noNetwork),
    dns: { lookup: unsupported("Bun.dns.lookup", noNetwork) },
    openInEditor: unsupported("Bun.openInEditor", noProcesses),
  };
  internal.BunFile = BunFile;
  Object.defineProperty(Bun, Symbol.toStringTag, { value: "Bun", configurable: true });
  return Bun;
})
