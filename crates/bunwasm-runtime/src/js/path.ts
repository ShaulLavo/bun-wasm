(function (internal: BunWasm.Internal) {
  "use strict";

  const native = internal.native.nodePath;
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

  function parse(windows: boolean, value: string): Parsed {
    const result = native.lexical(windows, "parse", encode(value));
    return { root: decode(result.root), dir: decode(result.dir), base: decode(result.base), ext: decode(result.ext), name: decode(result.name) };
  }

  function normalize(windows: boolean, value: string): string {
    return decode(native.lexical(windows, "normalize", encode(value)));
  }

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

  function device(root: string): string {
    if (root[1] === ":") return root.slice(0, 2);
    if (/^[/\\]{2}[^/\\]/.test(root)) return "\\\\" + root.split(/[/\\]+/).filter(Boolean).join("\\");
    return "";
  }

  function resolve(windows: boolean, paths: readonly string[]): string {
    let tail = "";
    let root = "";
    let absolute = false;
    for (let i = paths.length - 1; i >= -1 && !(absolute && (!windows || root)); i--) {
      const value = i >= 0 ? paths[i] : fallbackCwd(windows, root);
      if (!value) continue;
      const parsed = parse(windows, value);
      const nextDevice = windows ? device(parsed.root) : "";
      if (nextDevice && root && nextDevice.toLowerCase() !== root.toLowerCase()) continue;
      root ||= nextDevice;
      if (absolute) continue;
      tail = value.slice(parsed.root.length) + (windows ? "\\" : "/") + tail;
      absolute = windows ? native.lexical(true, "isAbsolute", encode(value)) : parsed.root === "/";
    }
    const separator = windows ? "\\" : "/";
    const result = normalize(windows, root + (absolute ? separator : "") + tail);
    const rootLength = parse(windows, result).root.length;
    return result.length > rootLength && result.endsWith(separator) ? result.slice(0, -1) : result;
  }

  function fallbackCwd(windows: boolean, root: string): string {
    const cwd = process.cwd();
    if (!windows || !root) return cwd;
    const cwdDevice = device(parse(true, cwd).root);
    return cwdDevice && cwdDevice.toLowerCase() !== root.toLowerCase() ? root + "\\" : cwd;
  }

  function relative(windows: boolean, from: string, to: string): string {
    if (from === to) return "";
    const source = resolve(windows, [from]);
    const target = resolve(windows, [to]);
    return decode(native.relative(windows, encode(source), encode(target)));
  }

  function toNamespacedPath(windows: boolean, value: unknown): unknown {
    if (!windows || typeof value !== "string" || !value) return value;
    const resolved = resolve(true, [value]);
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
    const lexical = (operation: "dirname" | "extname", value: unknown) => decode(native.lexical(windows, operation, encode(validateString(value, "path"))));
    const namespaced = (value: unknown) => toNamespacedPath(windows, value);
    return {
      resolve: (...values: unknown[]) => resolve(windows, resolutionStrings(windows, values)),
      normalize: (value: unknown) => normalize(windows, validateString(value, "path")),
      isAbsolute: (value: unknown) => native.lexical(windows, "isAbsolute", encode(validateString(value, "path"))),
      join: (...values: unknown[]) => decode(native.join(windows, strings(values).map(encode))),
      relative: (from: unknown, to: unknown) => relative(windows, validateString(from, "from"), validateString(to, "to")),
      toNamespacedPath: namespaced,
      _makeLong: namespaced,
      dirname: (value: unknown) => lexical("dirname", value),
      basename(value: unknown, suffix?: unknown) {
        if (suffix !== undefined && typeof suffix !== "string" && !(suffix instanceof String)) invalidType("ext", "string", suffix);
        const input = encode(validateString(value, "path"));
        const extension = suffix === undefined ? undefined : encode(String(suffix));
        return decode(native.lexical(windows, "basename", input, extension));
      },
      extname: (value: unknown) => lexical("extname", value),
      format: (value: unknown) => format(windows, value),
      parse: (value: unknown) => parse(windows, validateString(value, "path")),
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
