// process.binding(name), after Bun's Process_functionBinding (src/jsc/bindings/BunProcess.cpp)
// and its src/jsc/bindings/ProcessBinding*.cpp objects. Bun answers a fixed list: some names
// return an object (mostly stubs whose functions throw), the Node internals Bun never had
// throw "not implemented", and anything else is "No such module".
(function (internal: BunWasm.Internal) {
  "use strict";
  type Binding = Record<string, unknown>;

  const unimplemented = new Set([
    "async_wrap", "cares_wrap", "contextify", "crypto", "fs_event_wrap", "icu", "inspector", "js_stream", "os",
    "pipe_wrap", "process_wrap", "signal_wrap", "spawn_sync", "tcp_wrap", "tls_wrap", "udp_wrap", "url", "v8", "zlib",
  ]);
  const notImplementedTail = "is not implemented in Bun. If that breaks something, please file an issue and include a reproducible code sample.";

  // Bun's binding objects list functions it never implemented; each throws when called.
  function stubs(prefix: string, names: readonly string[], target: Binding = {}): Binding {
    for (const name of names) {
      target[name] = function () {
        throw new Error(`process.binding('${prefix}').${name} ${notImplementedTail}`);
      };
    }
    return target;
  }

  const bufferFunctions = [
    "asciiSlice", "asciiWriteStatic", "atob", "base64Slice", "base64Write", "base64urlSlice", "base64urlWrite", "btoa",
    "byteLengthUtf8", "compare", "compareOffset", "copy", "copyArrayBuffer", "detachArrayBuffer", "fill",
    "getZeroFillToggle", "hexSlice", "hexWrite", "indexOfBuffer", "indexOfNumber", "indexOfString", "isAscii", "isUtf8",
    "latin1Slice", "latin1WriteStatic", "swap16", "swap32", "swap64", "ucs2Slice", "ucs2Write", "utf8Slice",
    "utf8WriteStatic",
  ];
  const fsFunctions = [
    "access", "chmod", "chown", "close", "copyFile", "cpSyncCheckPaths", "existsSync", "fchmod", "fchown", "fdatasync",
    "fstat", "fsync", "ftruncate", "futimes", "getFormatOfExtensionlessFile", "internalModuleStat", "lchown",
    "legacyMainResolve", "link", "lstat", "lutimes", "mkdir", "mkdtemp", "open", "openFileHandle", "read", "readBuffers",
    "readdir", "readFileUtf8", "readlink", "realpath", "rename", "rmdir", "rmSync", "stat", "statfs", "StatWatcher",
    "symlink", "unlink", "utimes", "writeBuffer", "writeBuffers", "writeFileUtf8", "writeString",
  ];
  // llhttp's HTTP_METHOD_MAP and HTTP_ALL_METHOD_MAP, in their order.
  const httpMethods = [
    "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND",
    "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE",
    "M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE",
  ];
  const rtspMethods = ["PRI", "DESCRIBE", "ANNOUNCE", "SETUP", "PLAY", "PAUSE", "TEARDOWN", "GET_PARAMETER", "SET_PARAMETER", "REDIRECT", "RECORD", "FLUSH"];

  function bufferBinding(): Binding {
    const buffer = internal.builtin("node:buffer") as { kMaxLength: number; kStringMaxLength: number };
    return stubs("buffer", bufferFunctions, { kMaxLength: buffer.kMaxLength, kStringMaxLength: buffer.kStringMaxLength });
  }

  function fsBinding(): Binding {
    const fs = stubs("fs", fsFunctions);
    Object.defineProperties(fs, {
      statValues: { get: () => new Float64Array(36), enumerable: true, configurable: true },
      bigintStatValues: { get: () => new BigInt64Array(36), enumerable: true, configurable: true },
      statFsValues: { get: () => new Float64Array(7), enumerable: true, configurable: true },
      bigintStatFsValues: { get: () => new BigInt64Array(7), enumerable: true, configurable: true },
    });
    fs.kFsStatsFieldsNumber = 18;
    return fs;
  }

  // Bun's ProcessBindingConfig. bun-wasm is a 32-bit guest.
  function configBinding(): Binding {
    return {
      isDebugBuild: false, hasOpenSSL: true, fipsMode: true, hasIntl: true, hasTracing: true, hasNodeOptions: true,
      hasInspector: true, noBrowserGlobals: false, bits: 32,
    };
  }

  function nativesBinding(): Binding {
    const natives: Binding = {};
    const modules = (internal.builtin("node:module") as unknown as { builtinModules: readonly string[] }).builtinModules;
    for (const name of modules) {
      if (!name.includes(":")) natives[name] = "/* [native code] */";
    }
    return natives;
  }

  function ttyWrapBinding(): Binding {
    const isTTY = (fd: unknown) => internal.native.isatty(Number(fd));
    class TTY {
      constructor() {
        throw new TypeError("process.binding('tty_wrap').TTY is not supported in bun-wasm");
      }
    }
    return { isTTY, TTY };
  }

  function x509Binding(): Binding {
    return {
      isX509Certificate(value: unknown) {
        const { X509Certificate } = internal.builtin("node:crypto") as { X509Certificate?: abstract new (...args: never[]) => unknown };
        return typeof X509Certificate === "function" && value instanceof X509Certificate;
      },
    };
  }

  const builders: Record<string, () => unknown> = {
    buffer: bufferBinding,
    config: configBinding,
    "crypto/x509": x509Binding,
    fs: fsBinding,
    http_parser: () => ({ methods: httpMethods.concat(["QUERY"]), allMethods: httpMethods.concat(rtspMethods, ["QUERY"]) }),
    natives: nativesBinding,
    tty_wrap: ttyWrapBinding,
    util: () => (internal.builtin("node:util") as { types: object }).types,
  };
  const made = new Map<string, unknown>();

  return function binding(name: unknown, own: Record<string, () => unknown>): unknown {
    // Bun converts the name with ToString, so a symbol throws a TypeError.
    const key = `${name as string}`;
    if (unimplemented.has(key)) throw new Error(`process.binding("${key}") ${notImplementedTail}`);
    if (key === "stream_wrap") throw new Error(`process.binding("stream_wrap") is not implemented in Bun. Track the status & thumbs up the issue: https://github.com/oven-sh/bun/issues/4957`);
    if (Object.hasOwn(own, key)) return own[key]();
    if (!Object.hasOwn(builders, key)) throw new Error(`No such module: ${key}`);
    if (!made.has(key)) made.set(key, builders[key]());
    return made.get(key);
  };
})
