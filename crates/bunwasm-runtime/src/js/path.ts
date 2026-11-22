(function (internal: BunWasm.Internal) {
  "use strict";

  const native = internal.native.nodePath;
  const isWellFormed = internal.stringIsWellFormed;
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
  // follow Node's lib/path.js (docs/bun-patches/node-path.md).

  function posixIsAbsolute(path: string): boolean {
    return path.length > 0 && path.charCodeAt(0) === SLASH;
  }

  // Node's normalizeString: resolves `.` and `..` segments and drops empty ones.
  function normalizeSegments(path: string, allowAboveRoot: boolean): string {
    let result = "";
    let lastSegmentLength = 0;
    let lastSlash = -1;
    let dots = 0;
    let code = 0;
    for (let i = 0; i <= path.length; i++) {
      if (i < path.length) code = path.charCodeAt(i);
      else if (code === SLASH) break;
      else code = SLASH;
      if (code !== SLASH) {
        dots = code === DOT && dots !== -1 ? dots + 1 : -1;
        continue;
      }
      if (lastSlash === i - 1 || dots === 1) {
        // An empty or `.` segment adds nothing.
      } else if (dots === 2) {
        const parent = lastSegmentLength === 2 && result.length >= 2
          && result.charCodeAt(result.length - 1) === DOT && result.charCodeAt(result.length - 2) === DOT;
        if (!parent && result.length > 0) {
          const index = result.length > 2 ? result.lastIndexOf("/") : -1;
          result = index === -1 ? "" : result.slice(0, index);
          lastSegmentLength = index === -1 ? 0 : result.length - 1 - result.lastIndexOf("/");
        } else if (allowAboveRoot) {
          result += result.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        const segment = path.slice(lastSlash + 1, i);
        result += result.length > 0 ? "/" + segment : segment;
        lastSegmentLength = segment.length;
      }
      lastSlash = i;
      dots = 0;
    }
    return result;
  }

  // Without `//`, a leading `.` or `/.`, no segment is empty, `.` or `..`, so
  // the path is already normal.
  function isNormal(path: string): boolean {
    return path.charCodeAt(0) !== DOT && path.indexOf("//") === -1 && path.indexOf("/.") === -1;
  }

  function posixNormalize(path: string): string {
    if (path.length === 0) return ".";
    if (isNormal(path)) return path;
    const absolute = path.charCodeAt(0) === SLASH;
    const trailing = path.charCodeAt(path.length - 1) === SLASH;
    const normalized = normalizeSegments(path, !absolute);
    if (normalized.length === 0) return absolute ? "/" : trailing ? "./" : ".";
    const tail = trailing ? normalized + "/" : normalized;
    return absolute ? "/" + tail : tail;
  }

  function posixJoin(paths: readonly string[]): string {
    let joined = "";
    for (const path of paths) {
      if (path.length > 0) joined = joined.length > 0 ? joined + "/" + path : path;
    }
    return joined.length > 0 ? posixNormalize(joined) : ".";
  }

  function posixDirname(path: string): string {
    if (path.length === 0) return ".";
    const hasRoot = path.charCodeAt(0) === SLASH;
    let matchedSlash = true;
    let end = -1;
    for (let i = path.length - 1; i >= 1; i--) {
      if (path.charCodeAt(i) !== SLASH) {
        matchedSlash = false;
        continue;
      }
      if (!matchedSlash) {
        end = i;
        break;
      }
    }
    if (end === -1) return hasRoot ? "/" : ".";
    return hasRoot && end === 1 ? "//" : path.slice(0, end);
  }

  function posixBasename(path: string, suffix?: string): string {
    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) return basenameWithSuffix(path, suffix);
    let start = 0;
    let end = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path.charCodeAt(i) !== SLASH) {
        if (end === -1) end = i + 1;
        continue;
      }
      if (end !== -1) {
        start = i + 1;
        break;
      }
    }
    return end === -1 ? "" : path.slice(start, end);
  }

  function basenameWithSuffix(path: string, suffix: string): string {
    if (suffix === path) return "";
    let suffixIndex = suffix.length - 1;
    let firstNonSlashEnd = -1;
    let start = 0;
    let end = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const code = path.charCodeAt(i);
      if (code === SLASH && firstNonSlashEnd !== -1) {
        start = i + 1;
        break;
      }
      if (code === SLASH) continue;
      if (firstNonSlashEnd === -1) firstNonSlashEnd = i + 1;
      if (suffixIndex === -1) continue;
      if (code !== suffix.charCodeAt(suffixIndex)) {
        // The suffix does not match, so the result is the whole component.
        suffixIndex = -1;
        end = firstNonSlashEnd;
        continue;
      }
      suffixIndex--;
      if (suffixIndex === -1) end = i;
    }
    if (start === end) return path.slice(start, firstNonSlashEnd);
    return path.slice(start, end === -1 ? path.length : end);
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
      const code = path.charCodeAt(i);
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
    return scanComponent(path, 0) ? path.slice(dotIndex, componentEnd) : "";
  }

  function posixParse(path: string): Parsed {
    const parsed: Parsed = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) return parsed;
    const absolute = path.charCodeAt(0) === SLASH;
    if (absolute) parsed.root = "/";
    const extension = scanComponent(path, absolute ? 1 : 0);
    const start = componentStart === 0 && absolute ? 1 : componentStart;
    if (componentEnd !== -1 && extension) {
      parsed.name = path.slice(start, dotIndex);
      parsed.base = path.slice(start, componentEnd);
      parsed.ext = path.slice(dotIndex, componentEnd);
    } else if (componentEnd !== -1) {
      parsed.base = parsed.name = path.slice(start, componentEnd);
    }
    if (componentStart > 0) parsed.dir = path.slice(0, componentStart - 1);
    else if (absolute) parsed.dir = "/";
    return parsed;
  }

  function posixResolve(paths: readonly string[]): string {
    let tail = "";
    let absolute = false;
    for (let i = paths.length - 1; i >= -1 && !absolute; i--) {
      const value = i >= 0 ? paths[i] : process.cwd();
      if (!value) continue;
      absolute = value.startsWith("/");
      tail = value.slice(absolute ? 1 : 0) + "/" + tail;
    }
    const result = posixNormalize((absolute ? "/" : "") + tail);
    return result.length > 1 && result.endsWith("/") ? result.slice(0, -1) : result;
  }

  // Bun's relative computation after both sides are resolved. Resolved paths
  // start with `/` unless the guest cwd itself is relative.
  function posixRelative(from: string, to: string): string {
    if (from === to) return "";
    const source = posixResolve([from]);
    const target = posixResolve([to]);
    if (source === target) return "";
    const sourceLength = source.length - 1;
    const targetLength = target.length - 1;
    const length = Math.min(sourceLength, targetLength);
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const code = source.charCodeAt(1 + i);
      if (code !== target.charCodeAt(1 + i)) break;
      if (code === SLASH) lastCommonSep = i;
    }
    if (i === length && targetLength > length) {
      // `from` is the root or an exact base path of `to`.
      if (target.charCodeAt(1 + i) === SLASH) return target.slice(2 + i);
      if (i === 0) return target.slice(1);
    } else if (i === length && sourceLength > length) {
      // `to` is the root or an exact base path of `from`.
      if (source.charCodeAt(1 + i) === SLASH) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
    let out = "";
    for (i = lastCommonSep + 2; i <= source.length; i++) {
      if (i === source.length || source.charCodeAt(i) === SLASH) out += out.length > 0 ? "/.." : "..";
    }
    return out + target.slice(1 + lastCommonSep);
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
    resolve: windowsResolve,
    normalize: (value: string) => windowsLexical("normalize", value),
    isAbsolute: windowsIsAbsolute,
    join: windowsJoin,
    relative: windowsRelative,
    dirname: (value: string) => windowsLexical("dirname", value),
    basename: (value: string, suffix?: string) => windowsLexical("basename", value, suffix),
    extname: (value: string) => windowsLexical("extname", value),
    parse: windowsParse,
  };

  function strings(values: readonly unknown[]): string[] {
    return values.map((value, index) => validateString(value, `paths[${index}]`));
  }

  function resolutionStrings(windows: boolean, values: readonly unknown[]): string[] {
    const paths: string[] = [];
    for (let i = values.length - 1; i >= 0; i--) {
      const value = validateString(values[i], `paths[${i}]`);
      paths.push(value);
      if (!windows && value.startsWith("/")) break;
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
      resolve: (...values: unknown[]) => operations.resolve(resolutionStrings(windows, values)),
      normalize: (value: unknown) => operations.normalize(validateString(value, "path")),
      isAbsolute: (value: unknown) => operations.isAbsolute(validateString(value, "path")),
      join: (...values: unknown[]) => operations.join(strings(values)),
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
