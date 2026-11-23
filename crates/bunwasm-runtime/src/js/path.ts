(function (internal: BunWasm.Internal) {
  "use strict";

  const native = internal.native.nodePath;
  const isWellFormed = internal.stringIsWellFormed;
  // Captured in bootstrap.js before user code runs, so replacing a public
  // String.prototype method cannot change path results.
  const { charCodeAt, slice, indexOf, lastIndexOf } = internal.stringIntrinsics;
  const SLASH = 47;
  const DOT = 46;
  type StringOperation = "basename" | "dirname" | "extname" | "normalize";
  type Parsed = { root: string; dir: string; base: string; ext: string; name: string };
  type Namespace = ReturnType<typeof namespace> & { win32?: Namespace; posix?: Namespace };

  function invalidType(name: string, type: string, value: unknown): never {
    const got = Array.isArray(value) ? "array" : typeof value;
    const error = new TypeError(`The "${name}" property must be of type ${type}, got ${got}`);
    Object.assign(error, { code: "ERR_INVALID_ARG_TYPE" });
    throw error;
  }

  function validateString(value: unknown, name: string): string {
    if (typeof value === "string") return value;
    if (value instanceof String) return String(value);
    return invalidType(name, "string", value);
  }

  // POSIX operations are lexical, so they run here on UTF-16 code units without
  // crossing into Wasm. They port Bun's `bun_node_path` POSIX algorithms, which
  // follow Node's lib/path.js (docs/bun-patches/node-path.md). They call only
  // captured string intrinsics and build no arrays, so replaced prototype
  // methods or inherited index accessors cannot change a result.

  function posixIsAbsolute(path: string): boolean {
    return path.length > 0 && charCodeAt(path, 0) === SLASH;
  }

  // Kept segments as [start, end) offsets into the normalized path; a kept `..`
  // above the root has start -1. A typed array has no inherited index
  // accessors. Ordinary paths reuse one small buffer; a longer path gets its
  // own, so one huge path does not keep a large buffer alive. Capacity is
  // tracked here because `length` is an inherited, replaceable accessor.
  const SHARED_CAPACITY = 1024;
  const sharedBounds = new Int32Array(SHARED_CAPACITY);

  function isDotSegment(path: string, start: number, length: number): boolean {
    if (length === 1) return charCodeAt(path, start) === DOT;
    return length === 2 && charCodeAt(path, start) === DOT && charCodeAt(path, start + 1) === DOT;
  }

  // Node's normalizeString: resolves `.` and `..` segments and drops empty ones.
  // Node walks code units and edits a result string; a stack of segment
  // offsets gives the same result in linear time with native indexOf, which
  // interpreters run much faster. A `..` pops the previous segment unless that
  // is itself a kept `..`.
  function normalizeSegments(path: string, allowAboveRoot: boolean): string {
    // Kept segments are nonempty and separated, so at most length / 2 + 1.
    const bounds = path.length + 2 <= SHARED_CAPACITY ? sharedBounds : new Int32Array(path.length + 2);
    let count = 0;
    for (let start = 0; start <= path.length;) {
      const separator = indexOf(path, "/", start);
      const end = separator === -1 ? path.length : separator;
      const segmentStart = start;
      start = end + 1;
      if (end === segmentStart) continue;
      if (!isDotSegment(path, segmentStart, end - segmentStart)) {
        bounds[2 * count] = segmentStart;
        bounds[2 * count + 1] = end;
        count++;
      } else if (end - segmentStart === 1) {
        // A `.` segment adds nothing.
      } else if (count > 0 && bounds[2 * count - 2] !== -1) {
        count--;
      } else if (allowAboveRoot) {
        bounds[2 * count] = -1;
        count++;
      }
    }
    return joinSegments(path, bounds, count);
  }

  // Kept segments that sit next to each other in `path`, separated by one `/`,
  // are copied as one slice, so a mostly normal path costs a few slices.
  function joinSegments(path: string, bounds: Int32Array, count: number): string {
    let result = "";
    let runStart = 0;
    // Segments are nonempty, so a run's end is at least 1; -1 means no run.
    let runEnd = -1;
    for (let i = 0; i < count; i++) {
      const start = bounds[2 * i]!;
      if (runEnd !== -1 && start === runEnd + 1) {
        runEnd = bounds[2 * i + 1]!;
        continue;
      }
      if (runEnd !== -1) result = appendSegment(result, slice(path, runStart, runEnd));
      runEnd = -1;
      if (start === -1) {
        result = appendSegment(result, "..");
        continue;
      }
      runStart = start;
      runEnd = bounds[2 * i + 1]!;
    }
    return runEnd === -1 ? result : appendSegment(result, slice(path, runStart, runEnd));
  }

  function appendSegment(result: string, segment: string): string {
    return result.length > 0 ? result + "/" + segment : segment;
  }

  // Without `//`, a leading `.` or `/.`, no segment is empty, `.` or `..`, so
  // the path is already normal.
  function isNormal(path: string): boolean {
    return charCodeAt(path, 0) !== DOT && indexOf(path, "//") === -1 && indexOf(path, "/.") === -1;
  }

  function posixNormalize(path: string): string {
    if (path.length === 0) return ".";
    if (isNormal(path)) return path;
    const absolute = charCodeAt(path, 0) === SLASH;
    const trailing = charCodeAt(path, path.length - 1) === SLASH;
    const normalized = normalizeSegments(path, !absolute);
    if (normalized.length === 0) return absolute ? "/" : trailing ? "./" : ".";
    const tail = trailing ? normalized + "/" : normalized;
    return absolute ? "/" + tail : tail;
  }

  // Validates and joins left to right, as validating every argument first and
  // then joining would.
  function posixJoin(values: readonly unknown[]): string {
    let joined = "";
    for (let i = 0; i < values.length; i++) {
      const path = pathArgument(values[i], i);
      if (path.length > 0) joined = joined.length > 0 ? joined + "/" + path : path;
    }
    return joined.length > 0 ? posixNormalize(joined) : ".";
  }

  // Index of the last code unit that is not a trailing `/`, or -1.
  function lastNonSlash(path: string): number {
    let last = path.length - 1;
    while (last >= 0 && charCodeAt(path, last) === SLASH) last--;
    return last;
  }

  function posixDirname(path: string): string {
    if (path.length === 0) return ".";
    const hasRoot = charCodeAt(path, 0) === SLASH;
    // Node scans down to index 1: the separator before the last component,
    // without trimming repeated separators before it.
    const last = lastNonSlash(path);
    const end = last < 1 ? -1 : lastIndexOf(path, "/", last);
    if (end < 1) return hasRoot ? "/" : ".";
    return hasRoot && end === 1 ? "//" : slice(path, 0, end);
  }

  function posixBasename(path: string, suffix?: string): string {
    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) return basenameWithSuffix(path, suffix);
    const last = lastNonSlash(path);
    if (last === -1) return "";
    return slice(path, lastIndexOf(path, "/", last) + 1, last + 1);
  }

  function basenameWithSuffix(path: string, suffix: string): string {
    if (suffix === path) return "";
    let suffixIndex = suffix.length - 1;
    let firstNonSlashEnd = -1;
    let start = 0;
    let end = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const code = charCodeAt(path, i);
      if (code === SLASH && firstNonSlashEnd !== -1) {
        start = i + 1;
        break;
      }
      if (code === SLASH) continue;
      if (firstNonSlashEnd === -1) firstNonSlashEnd = i + 1;
      if (suffixIndex === -1) continue;
      if (code !== charCodeAt(suffix, suffixIndex)) {
        // The suffix does not match, so the result is the whole component.
        suffixIndex = -1;
        end = firstNonSlashEnd;
        continue;
      }
      suffixIndex--;
      if (suffixIndex === -1) end = i;
    }
    if (start === end) return slice(path, start, firstNonSlashEnd);
    return slice(path, start, end === -1 ? path.length : end);
  }

  // Shared scan of the last path component, from Node's extname and parse.
  // It records the component bounds and reports whether it has an extension.
  let componentStart = 0;
  let componentEnd = -1;
  let dotIndex = -1;

  function scanComponent(path: string, first: number): boolean {
    componentStart = 0;
    componentEnd = -1;
    dotIndex = -1;
    // 0: nothing before the dot yet, 1: only dots, -1: a non-dot character.
    let preDotState = 0;
    for (let i = path.length - 1; i >= first; i--) {
      const code = charCodeAt(path, i);
      if (code === SLASH && componentEnd !== -1) {
        componentStart = i + 1;
        break;
      }
      if (code === SLASH) continue;
      if (componentEnd === -1) componentEnd = i + 1;
      if (code !== DOT) {
        if (dotIndex !== -1) preDotState = -1;
        continue;
      }
      if (dotIndex === -1) dotIndex = i;
      else if (preDotState !== -1) preDotState = 1;
    }
    if (dotIndex === -1 || componentEnd === -1 || preDotState === 0) return false;
    // The trimmed component is exactly `..`.
    return !(preDotState === 1 && dotIndex === componentEnd - 1 && dotIndex === componentStart + 1);
  }

  function posixExtname(path: string): string {
    return scanComponent(path, 0) ? slice(path, dotIndex, componentEnd) : "";
  }

  function posixParse(path: string): Parsed {
    const parsed: Parsed = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) return parsed;
    const absolute = charCodeAt(path, 0) === SLASH;
    if (absolute) parsed.root = "/";
    const extension = scanComponent(path, absolute ? 1 : 0);
    const start = componentStart === 0 && absolute ? 1 : componentStart;
    if (componentEnd !== -1 && extension) {
      parsed.name = slice(path, start, dotIndex);
      parsed.base = slice(path, start, componentEnd);
      parsed.ext = slice(path, dotIndex, componentEnd);
    } else if (componentEnd !== -1) {
      parsed.base = parsed.name = slice(path, start, componentEnd);
    }
    if (componentStart > 0) parsed.dir = slice(path, 0, componentStart - 1);
    else if (absolute) parsed.dir = "/";
    return parsed;
  }

  // Validates right to left and stops at the last absolute argument. Only then
  // is the guest cwd read.
  function posixResolve(values: readonly unknown[]): string {
    let tail = "";
    let absolute = false;
    for (let i = values.length - 1; i >= 0 && !absolute; i--) {
      const value = pathArgument(values[i], i);
      if (value.length === 0) continue;
      absolute = charCodeAt(value, 0) === SLASH;
      tail = slice(value, absolute ? 1 : 0) + "/" + tail;
    }
    if (!absolute) {
      const cwd: unknown = process.cwd();
      absolute = cwdIsAbsolute(cwd);
      if (cwd) tail = cwdTail(cwd, absolute) + "/" + tail;
    }
    const result = posixNormalize((absolute ? "/" : "") + tail);
    return result.length > 1 && charCodeAt(result, result.length - 1) === SLASH ? slice(result, 0, -1) : result;
  }

  // A replaced `process.cwd` may return anything. Strings use the captured
  // intrinsics; other values keep the previous adapter's method calls and their
  // errors. An empty or falsy cwd is skipped.
  type CwdLike = { startsWith(search: string): boolean; slice(start: number): string };

  // `value` keeps the previous expressions, whose text engines quote in errors.
  function cwdIsAbsolute(value: unknown): boolean {
    if (!value) return false;
    return typeof value === "string" ? charCodeAt(value, 0) === SLASH : (value as CwdLike).startsWith("/");
  }

  function cwdTail(value: unknown, absolute: boolean): string {
    return typeof value === "string" ? slice(value, absolute ? 1 : 0) : (value as CwdLike).slice(absolute ? 1 : 0);
  }

  function posixRelative(from: string, to: string): string {
    if (from === to) return "";
    const source = posixResolve([from]);
    const target = posixResolve([to]);
    if (source === target) return "";
    const result = relativeResolved(source, target);
    // A relative guest cwd can make the fixed offset below split a surrogate
    // pair. Bun's string route rejects such a result for well-formed inputs.
    if (!isWellFormed(result) && isWellFormed(source) && isWellFormed(target)) {
      throw new Error("Path string result contains an unpaired surrogate");
    }
    return result;
  }

  // Bun's relative computation after both sides are resolved. Resolved paths
  // start with `/` unless the guest cwd itself is relative.
  function relativeResolved(source: string, target: string): string {
    const sourceLength = source.length - 1;
    const targetLength = target.length - 1;
    const length = sourceLength < targetLength ? sourceLength : targetLength;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const code = charCodeAt(source, 1 + i);
      if (code !== charCodeAt(target, 1 + i)) break;
      if (code === SLASH) lastCommonSep = i;
    }
    if (i === length && targetLength > length) {
      // `from` is the root or an exact base path of `to`.
      if (charCodeAt(target, 1 + i) === SLASH) return slice(target, 2 + i);
      if (i === 0) return slice(target, 1);
    } else if (i === length && sourceLength > length) {
      // `to` is the root or an exact base path of `from`.
      if (charCodeAt(source, 1 + i) === SLASH) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
    let out = "";
    for (i = lastCommonSep + 2; i <= source.length; i++) {
      if (i === source.length || charCodeAt(source, i) === SLASH) out += out.length > 0 ? "/.." : "..";
    }
    return out + slice(target, 1 + lastCommonSep);
  }

  // Windows operations keep Bun's native algorithms, with a lossless UTF-16
  // route for strings that contain unpaired surrogates.

  function encode(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
    return bytes;
  }

  function decode(bytes: Uint8Array): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 8192) chunks.push(decodeChunk(view, offset));
    return chunks.join("");
  }

  function decodeChunk(view: DataView, offset: number): string {
    const units: number[] = [];
    for (let i = offset; i < Math.min(offset + 8192, view.byteLength); i += 2) units.push(view.getUint16(i, true));
    return String.fromCharCode(...units);
  }

  function windowsParse(value: string): Parsed {
    if (isWellFormed(value)) return native.lexicalString("parse", value);
    const result = native.lexicalUnits("parse", encode(value));
    return { root: decode(result.root), dir: decode(result.dir), base: decode(result.base), ext: decode(result.ext), name: decode(result.name) };
  }

  function windowsLexical(operation: StringOperation, value: string, suffix?: string): string {
    if (isWellFormed(value) && (suffix === undefined || isWellFormed(suffix))) return native.lexicalString(operation, value, suffix);
    return decode(native.lexicalUnits(operation, encode(value), suffix === undefined ? undefined : encode(suffix)));
  }

  function windowsJoin(paths: readonly string[]): string {
    if (paths.every(isWellFormed)) return native.joinString(paths);
    return decode(native.joinUnits(paths.map(encode)));
  }

  function windowsIsAbsolute(value: string): boolean {
    if (isWellFormed(value)) return native.lexicalString("isAbsolute", value);
    return native.lexicalUnits("isAbsolute", encode(value));
  }

  function windowsResolve(paths: readonly string[]): string {
    return decode(native.resolveWindows(encode(process.cwd()), paths.map(encode)));
  }

  function windowsRelative(from: string, to: string): string {
    if (from === to) return "";
    const source = windowsResolve([from]);
    const target = windowsResolve([to]);
    if (isWellFormed(source) && isWellFormed(target)) return native.relativeString(source, target);
    return decode(native.relativeUnits(encode(source), encode(target)));
  }

  const posixOperations = {
    resolve: posixResolve,
    normalize: posixNormalize,
    isAbsolute: posixIsAbsolute,
    join: posixJoin,
    relative: posixRelative,
    dirname: posixDirname,
    basename: posixBasename,
    extname: posixExtname,
    parse: posixParse,
  };

  const windowsOperations: typeof posixOperations = {
    resolve: (values: readonly unknown[]) => windowsResolve(resolutionStrings(values)),
    normalize: (value: string) => windowsLexical("normalize", value),
    isAbsolute: windowsIsAbsolute,
    join: (values: readonly unknown[]) => windowsJoin(strings(values)),
    relative: windowsRelative,
    dirname: (value: string) => windowsLexical("dirname", value),
    basename: (value: string, suffix?: string) => windowsLexical("basename", value, suffix),
    extname: (value: string) => windowsLexical("extname", value),
    parse: windowsParse,
  };

  // Valid strings skip validateString so hot calls build no argument label.
  function pathArgument(value: unknown, index: number): string {
    return typeof value === "string" ? value : validateString(value, `paths[${index}]`);
  }

  // The Windows wrappers keep the previous adapter's code exactly, including
  // what replaced array methods could observe.
  function strings(values: readonly unknown[]): string[] {
    return values.map((value, index) => validateString(value, `paths[${index}]`));
  }

  // Windows resolution validates every argument, right to left.
  function resolutionStrings(values: readonly unknown[]): string[] {
    const paths: string[] = [];
    for (let i = values.length - 1; i >= 0; i--) {
      const value = validateString(values[i], `paths[${i}]`);
      paths.push(value);
    }
    paths.reverse();
    return paths;
  }

  function toNamespacedPath(windows: boolean, value: unknown): unknown {
    if (!windows || typeof value !== "string" || !value) return value;
    const resolved = windowsResolve([value]);
    if (/^\\\\[^?.]/.test(resolved)) return "\\\\?\\UNC\\" + resolved.slice(2);
    if (/^[a-z]:\\/i.test(resolved)) return "\\\\?\\" + resolved;
    return resolved.length <= 2 ? value : resolved;
  }

  function format(windows: boolean, input: unknown): string {
    if (input === null || typeof input !== "object") return invalidType("pathObject", "object", input);
    const property = (key: string): unknown => Reflect.get(input, key);
    const dir = property("dir") || property("root");
    const ext = property("ext") || "";
    const extension = String(ext);
    const base = property("base") || `${property("name") || ""}${extension && extension[0] !== "." ? "." : ""}${extension}`;
    if (!dir) return String(base);
    return dir === property("root") ? `${dir}${base}` : `${dir}${windows ? "\\" : "/"}${base}`;
  }

  function namespace(windows: boolean) {
    const namespaced = (value: unknown) => toNamespacedPath(windows, value);
    const operations = windows ? windowsOperations : posixOperations;
    return {
      resolve: (...values: unknown[]) => operations.resolve(values),
      normalize: (value: unknown) => operations.normalize(validateString(value, "path")),
      isAbsolute: (value: unknown) => operations.isAbsolute(validateString(value, "path")),
      join: (...values: unknown[]) => operations.join(values),
      relative: (from: unknown, to: unknown) => operations.relative(validateString(from, "from"), validateString(to, "to")),
      toNamespacedPath: namespaced,
      _makeLong: namespaced,
      dirname: (value: unknown) => operations.dirname(validateString(value, "path")),
      basename(value: unknown, suffix?: unknown) {
        if (suffix !== undefined && typeof suffix !== "string" && !(suffix instanceof String)) invalidType("ext", "string", suffix);
        const input = validateString(value, "path");
        const extension = suffix === undefined ? undefined : String(suffix);
        return operations.basename(input, extension);
      },
      extname: (value: unknown) => operations.extname(validateString(value, "path")),
      format: (value: unknown) => format(windows, value),
      parse: (value: unknown) => operations.parse(validateString(value, "path")),
      matchesGlob(value: unknown, pattern: unknown) {
        const path = validateString(value, "path");
        const glob = validateString(pattern, "pattern");
        return internal.native.globMatch(windows ? glob.replaceAll("\\", "/") : glob, windows ? path.replaceAll("\\", "/") : path);
      },
      sep: windows ? "\\" : "/",
      delimiter: windows ? ";" : ":",
    };
  }

  const posix: Namespace = namespace(false);
  const win32: Namespace = namespace(true);
  posix.posix = win32.posix = posix;
  posix.win32 = win32.win32 = win32;
  return posix;
});
