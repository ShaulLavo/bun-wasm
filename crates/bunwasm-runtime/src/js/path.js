// node:path polyfill (POSIX). Ported from Node's lib/path.js posix
// implementation. `path.win32` is the same POSIX logic with win32 separators
// exposed; it does not implement Windows path semantics.
(function (_internal) {
  "use strict";

  const CHAR_DOT = 46;
  const CHAR_FORWARD_SLASH = 47;

  // Bun's wording: `The "path" property must be of type string, got number`.
  function validateString(value, name) {
    if (typeof value === "string") return value;
    if (value instanceof String) return String.prototype.valueOf.call(value);
    throw invalidType(name, "string", value);
  }

  function invalidType(name, type, value) {
    const got = Array.isArray(value) ? "array" : typeof value;
    const err = new TypeError(`The "${name}" property must be of type ${type}, got ${got}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    return err;
  }

  function validateObject(value, name) {
    if (value !== null && typeof value === "object") return;
    throw invalidType(name, "object", value);
  }

  function cwd() {
    if (typeof process !== "undefined" && typeof process.cwd === "function") return process.cwd();
    return "/";
  }

  // Resolves . and .. elements in a path with directory names.
  function normalizeString(path, allowAboveRoot) {
    let res = "";
    let lastSegmentLength = 0;
    let lastSlash = -1;
    let dots = 0;
    let code = 0;
    for (let i = 0; i <= path.length; ++i) {
      if (i < path.length) code = path.charCodeAt(i);
      else if (code === CHAR_FORWARD_SLASH) break;
      else code = CHAR_FORWARD_SLASH;

      if (code !== CHAR_FORWARD_SLASH) {
        dots = code === CHAR_DOT && dots !== -1 ? dots + 1 : -1;
        continue;
      }
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment or '.': nothing to do.
      } else if (dots === 2) {
        const popped = popSegment(res, lastSegmentLength);
        if (popped !== null) {
          res = popped.res;
          lastSegmentLength = popped.lastSegmentLength;
        } else if (allowAboveRoot) {
          res += res.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        const segment = path.slice(lastSlash + 1, i);
        res = res.length > 0 ? `${res}/${segment}` : segment;
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    }
    return res;
  }

  // Removes the last segment of `res` for a '..'; null when it can't (above root or a '..').
  function popSegment(res, lastSegmentLength) {
    const endsWithDots =
      lastSegmentLength === 2 &&
      res.charCodeAt(res.length - 1) === CHAR_DOT &&
      res.charCodeAt(res.length - 2) === CHAR_DOT;
    if (res.length >= 2 && endsWithDots) return null;
    if (res.length > 2) {
      const lastSlashIndex = res.lastIndexOf("/");
      if (lastSlashIndex === -1) return { res: "", lastSegmentLength: 0 };
      const next = res.slice(0, lastSlashIndex);
      return { res: next, lastSegmentLength: next.length - 1 - next.lastIndexOf("/") };
    }
    if (res.length !== 0) return { res: "", lastSegmentLength: 0 };
    return null;
  }

  function resolve() {
    let resolvedPath = "";
    let resolvedAbsolute = false;
    for (let i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      const path = validateString(i >= 0 ? arguments[i] : cwd(), `paths[${i}]`);
      if (path.length === 0) continue;
      resolvedPath = `${path}/${resolvedPath}`;
      resolvedAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    }
    resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
    if (resolvedAbsolute) return `/${resolvedPath}`;
    return resolvedPath.length > 0 ? resolvedPath : ".";
  }

  function normalize(path) {
    path = validateString(path, "path");
    if (path.length === 0) return ".";
    const isAbs = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;
    let out = normalizeString(path, !isAbs);
    if (out.length === 0) {
      if (isAbs) return "/";
      return trailingSeparator ? "./" : ".";
    }
    if (trailingSeparator) out += "/";
    return isAbs ? `/${out}` : out;
  }

  function isAbsolute(path) {
    path = validateString(path, "path");
    return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }

  function join() {
    if (arguments.length === 0) return ".";
    const parts = [];
    for (let i = 0; i < arguments.length; ++i) {
      const arg = validateString(arguments[i], `paths[${i}]`);
      if (arg.length > 0) parts.push(arg);
    }
    if (parts.length === 0) return ".";
    return normalize(parts.join("/"));
  }

  function relative(from, to) {
    from = validateString(from, "from");
    to = validateString(to, "to");
    if (from === to) return "";
    from = resolve(from);
    to = resolve(to);
    if (from === to) return "";

    const fromStart = 1;
    const fromEnd = from.length;
    const fromLen = fromEnd - fromStart;
    const toStart = 1;
    const toLen = to.length - toStart;

    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) break;
      if (fromCode === CHAR_FORWARD_SLASH) lastCommonSep = i;
    }
    if (i === length) {
      if (toLen > length) {
        // `from` is a prefix of `to`: '/foo/bar' -> '/foo/bar/baz', or '/' -> '/foo'.
        if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) return to.slice(toStart + i + 1);
        if (i === 0) return to.slice(toStart + i);
      } else if (fromLen > length) {
        // `to` is a prefix of `from`.
        if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) lastCommonSep = i;
        else if (i === 0) lastCommonSep = 0;
      }
    }

    let out = "";
    // One '..' per remaining segment of `from` after the common prefix.
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) out += out.length === 0 ? ".." : "/..";
    }
    return `${out}${to.slice(toStart + lastCommonSep)}`;
  }

  function toNamespacedPath(path) {
    return path;
  }

  function dirname(path) {
    path = validateString(path, "path");
    if (path.length === 0) return ".";
    const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
      if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        matchedSlash = false;
      }
    }
    if (end === -1) return hasRoot ? "/" : ".";
    if (hasRoot && end === 1) return "//";
    return path.slice(0, end);
  }

  function basenameNoExt(path) {
    let start = 0;
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 0; --i) {
      if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }
    if (end === -1) return "";
    return path.slice(start, end);
  }

  function basename(path, suffix) {
    if (suffix !== undefined) validateString(suffix, "ext");
    path = validateString(path, "path");
    if (suffix === undefined || suffix.length === 0 || suffix.length > path.length) return basenameNoExt(path);
    if (suffix === path) return "";
    return basenameWithSuffix(path, suffix);
  }

  function basenameWithSuffix(path, suffix) {
    let start = 0;
    let end = -1;
    let matchedSlash = true;
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
        continue;
      }
      if (firstNonSlashEnd === -1) {
        matchedSlash = false;
        firstNonSlashEnd = i + 1;
      }
      if (extIdx < 0) continue;
      // Try to match the explicit suffix.
      if (code === suffix.charCodeAt(extIdx)) {
        if (--extIdx === -1) end = i;
      } else {
        extIdx = -1;
        end = firstNonSlashEnd;
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }

  // Shared scan for extname/parse: finds the base name and its last dot.
  function scanExt(path, stopIndex) {
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;
    let i = path.length - 1;
    for (; i >= stopIndex; --i) {
      const code = path.charCodeAt(i);
      if (code === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === CHAR_DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }
    const noExt =
      startDot === -1 ||
      end === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1);
    return { startDot, startPart, end, noExt };
  }

  function extname(path) {
    path = validateString(path, "path");
    const scan = scanExt(path, 0);
    if (scan.noExt) return "";
    return path.slice(scan.startDot, scan.end);
  }

  function format(pathObject) {
    validateObject(pathObject, "pathObject");
    const dir = pathObject.dir || pathObject.root;
    const ext = pathObject.ext || "";
    const extWithDot = ext && ext[0] !== "." ? `.${ext}` : ext;
    const base = pathObject.base || `${pathObject.name || ""}${extWithDot}`;
    if (!dir) return base;
    return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`;
  }

  function parse(path) {
    path = validateString(path, "path");
    const ret = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) return ret;
    const isAbs = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    if (isAbs) ret.root = "/";
    const start = isAbs ? 1 : 0;
    const scan = scanExt(path, start);
    if (scan.end !== -1) {
      const begin = scan.startPart === 0 && isAbs ? 1 : scan.startPart;
      if (scan.noExt) {
        ret.base = ret.name = path.slice(begin, scan.end);
      } else {
        ret.name = path.slice(begin, scan.startDot);
        ret.base = path.slice(begin, scan.end);
        ret.ext = path.slice(scan.startDot, scan.end);
      }
    }
    if (scan.startPart > 0) ret.dir = path.slice(0, scan.startPart - 1);
    else if (isAbs) ret.dir = "/";
    return ret;
  }

  const posix = {
    resolve,
    normalize,
    isAbsolute,
    join,
    relative,
    toNamespacedPath,
    dirname,
    basename,
    extname,
    format,
    parse,
    sep: "/",
    delimiter: ":",
    win32: null,
    posix: null,
  };

  // Minimal win32 namespace: same functions, win32 separators.
  const win32 = Object.assign({}, posix, { sep: "\\", delimiter: ";" });

  posix.posix = posix;
  posix.win32 = win32;
  win32.posix = posix;
  win32.win32 = win32;

  return posix;
});
