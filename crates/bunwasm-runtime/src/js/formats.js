// Public data formats. Parsing belongs to Bun's Rust crates; this module
// materializes their graph and handles JS serialization semantics.
(function (internal) {
  "use strict";
  const native = internal.native;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const unbox = (v) => v instanceof Number || v instanceof String || v instanceof Boolean ? v.valueOf() : v;
  const omitted = (v) => v === undefined || typeof v === "function" || typeof v === "symbol";

  function hydrate(graph) {
    const nodes = graph.nodes.map((n) => n[0] === "array" ? [] : {});
    function value(v) {
      switch (v[0]) {
        case 0: return v[1];
        case 1: return nodes[v[1]];
        case 2: return BigInt(v[1]);
        case 3:
          if (!globalThis.Temporal) throw new TypeError("Date/time values require Temporal, which is disabled in this process");
          return globalThis.Temporal[v[1]].from(v[2]);
        case 4: return Number(v[1]);
        case 5: return v[1].map((c) => String.fromCharCode(c)).join("");
        case 6: return undefined;
      }
    }
    function fill(node, i) {
      if (node[0] === "array") {
        for (const item of node[1]) nodes[i].push(value(item));
        return;
      }
      for (const [key, item] of node[1]) Object.defineProperty(nodes[i], String(value(key)), { value: value(item), enumerable: true, writable: true, configurable: true });
    }
    graph.nodes.forEach((node, i) => { if (node[0] === "array") fill(node, i); });
    graph.nodes.forEach((node, i) => { if (node[0] !== "array") fill(node, i); });
    return value(graph.root);
  }

  function textBytes(input, escapeSurrogates) {
    const text = String(input);
    const fixed = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (c) => escapeSurrogates ? "\\u" + c.charCodeAt(0).toString(16) : "\uFFFD");
    return native.utf8Encode(fixed);
  }

  function parse(input, format) {
    if (format !== "YAML" && input == null) throw new TypeError("Expected a string to parse");
    if (format === "JSONC" || format === "JSON") input = textBytes(input, true);
    else if (input instanceof Blob) input = input._bytes();
    else if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer)) input = internal.toUint8(input);
    else input = textBytes(input, false);
    if (input.byteLength > 0x7fffffff) throw new RangeError("input.byteLength must be <= 2147483647");
    return hydrate(jsonParse(native.parseData(input, format)));
  }

  function spacing(space) {
    space = unbox(space);
    if (typeof space === "number") return " ".repeat(Math.min(10, Math.max(0, Math.trunc(space) || 0)));
    return typeof space === "string" ? space.slice(0, 10) : "";
  }

  const escapes = { "\0": "\\0", "\x07": "\\a", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\v": "\\v", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\", "\x1b": "\\e", "\x85": "\\N", "\xa0": "\\_", "\u2028": "\\L", "\u2029": "\\P" };
  function yamlQuote(s) {
    // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
    return '"' + s.replace(/[\x00-\x1f"\\\x7f\x85\xa0\u2028\u2029]/g, (c) => escapes[c] || "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")) + '"';
  }
  function yamlString(s) {
    if (!s || /^[&*?|\-<>!%@:,[\]{}#'"` \t\r\n\uFEFF]/.test(s) || /[ \t\r\n:]$/.test(s)) return yamlQuote(s);
    // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
    if (/[{}[\],#`'"\x00-\x1f\x7f\x85\xa0\u2028\u2029]|:[ \t\r\n]|(?:---|\.\.\.)(?:$|[ \t\r\n[\]{},])/.test(s)) return yamlQuote(s);
    if (/^(?:true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|n|N|y|Y|null|Null|NULL|~|\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$/.test(s)) return yamlQuote(s);
    if (/^[-+]?(?:\.inf|\.Inf|\.INF|(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?))$/.test(s)) return yamlQuote(s);
    return s;
  }
  function number(v, format) {
    if (Object.is(v, -0)) return "-0";
    if (Number.isNaN(v)) return format === "YAML" ? ".nan" : format === "TOML" ? "nan" : "NaN";
    if (!Number.isFinite(v)) return (v < 0 ? "-" : "") + (format === "YAML" ? ".inf" : format === "TOML" ? "inf" : "Infinity");
    return String(v);
  }

  function aliases(root) {
    const seen = new Map();
    const names = new Map([["root", 0]]);
    let item = 0;
    function name(key) {
      if (key === null) return "item" + item++;
      const safe = /^[\w.-]+$/.test(key) && !/^(?:value|item|root)\d+$/.test(key);
      const base = safe ? key : "value";
      const count = names.has(base) ? names.get(base) + 1 : 0;
      names.set(base, count);
      return base + (safe && !count ? "" : count);
    }
    function visit(v, key) {
      v = unbox(v);
      if (typeof v === "bigint") throw new TypeError("YAML.stringify cannot serialize BigInt");
      if (v === null || typeof v !== "object") return;
      const prev = seen.get(v);
      if (prev) {
        if (!prev.name) prev.name = prev.key === undefined ? "root" : name(prev.key);
        return;
      }
      seen.set(v, { key, name: "", written: false });
      for (const [k, child] of entries(v)) visit(child, Array.isArray(v) ? null : k);
    }
    visit(root, undefined);
    return seen;
  }
  function entries(v) {
    const pairs = Array.isArray(v) ? Array.from({ length: v.length }, (_, i) => [String(i), v[i]]) : Object.keys(v).map((k) => [k, v[k]]);
    return pairs.filter((e) => !omitted(e[1]));
  }

  function yamlStringify(value, replacer, space) {
    if (omitted(value)) return undefined;
    if (replacer != null) throw new TypeError("YAML.stringify does not support the replacer argument");
    const unit = spacing(space);
    const seen = aliases(value);
    let depth = 0, offset = 0;
    const newline = () => unit ? "\n" + unit.repeat(depth) + " ".repeat(offset) : "";
    function collection(v, afterKey) {
      const anchor = seen.get(v);
      let prefix = "";
      if (anchor && anchor.name) {
        prefix = (afterKey ? newline() : "") + (anchor.written ? "*" : "&") + anchor.name;
        if (anchor.written) return prefix;
        anchor.written = true;
        prefix += unit ? newline() : " ";
        afterKey = false;
      }
      const pairs = entries(v);
      if (!pairs.length) return prefix + (afterKey ? " " : "") + (Array.isArray(v) ? "[]" : "{}");
      if (!unit) return prefix + (Array.isArray(v) ? "[" + pairs.map((e) => emit(e[1], false)).join(",") + "]" : "{" + pairs.map((e) => yamlString(e[0]) + ": " + emit(e[1], false)).join(",") + "}");
      return prefix + pairs.map((pair, i) => block(v, pair, i > 0 || afterKey)).join("");
    }
    function block(v, pair, line) {
      let out = line ? newline() : "";
      if (Array.isArray(v)) {
        offset += 2;
        out += "- " + emit(pair[1], false);
        offset -= 2;
        return out;
      }
      out += yamlString(pair[0]) + ":";
      depth++;
      out += emit(pair[1], true);
      depth--;
      return out;
    }
    function emit(v, afterKey) {
      v = unbox(v);
      if (v !== null && typeof v === "object") return collection(v, afterKey);
      const prefix = afterKey ? " " : "";
      if (typeof v === "string") return prefix + yamlString(v);
      if (typeof v === "number") return prefix + number(v, "YAML");
      return prefix + String(v);
    }
    return emit(value, false);
  }

  function json5Quote(s) {
    // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
    return "'" + s.replace(/[\x00-\x1f'\\\x7f\u2028\u2029]/g, (c) => {
      const known = { "\0": "\\0", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\v": "\\v", "\f": "\\f", "\r": "\\r", "'": "\\'", "\\": "\\\\", "\u2028": "\\u2028", "\u2029": "\\u2029" };
      return known[c] || "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
    }) + "'";
  }
  function json5Stringify(value, replacer, space) {
    if (omitted(value)) return undefined;
    if (replacer != null) throw new TypeError("JSON5.stringify does not support the replacer argument");
    const unit = spacing(space), visiting = new Set();
    function emit(v, depth) {
      v = unbox(v);
      if (v === null) return "null";
      if (typeof v === "string") return json5Quote(v);
      if (typeof v === "number") return number(v, "JSON5");
      if (typeof v === "bigint") throw new TypeError("JSON5.stringify cannot serialize BigInt");
      if (typeof v !== "object") return String(v);
      if (visiting.has(v)) throw new TypeError("Converting circular structure to JSON5");
      visiting.add(v);
      const array = Array.isArray(v);
      const pairs = array ? Array.from({ length: v.length }, (_, i) => [String(i), omitted(v[i]) ? null : v[i]]) : entries(v);
      const items = pairs.map(([k, child]) => (array ? "" : (/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(k) ? k : json5Quote(k)) + ":" + (unit ? " " : "")) + emit(child, depth + 1));
      visiting.delete(v);
      const body = !items.length ? "" : unit ? "\n" + unit.repeat(depth + 1) + items.join(",\n" + unit.repeat(depth + 1)) + ",\n" + unit.repeat(depth) : items.join(",");
      return (array ? "[" : "{") + body + (array ? "]" : "}");
    }
    return emit(value, 0);
  }

  function usv(text) {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  }
  const tomlQuote = (s) => jsonStringify(usv(s)).replace(/\x7f/g, "\\u007f");
  const tomlKey = (k) => /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlQuote(k);
  const temporalType = (v) => Object.prototype.toString.call(v).slice(8, -1).match(/^Temporal\.(.+)$/)?.[1];
  function tomlDate(v, type) {
    const name = v instanceof Date ? "Date" : "Temporal." + type;
    let text;
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) throw new TypeError("TOML.stringify cannot serialize an invalid Date");
      text = v.toISOString().replace(/\.([0-9]*?)0+Z$/, (_, digits) => (digits ? "." + digits : "") + "Z");
    } else {
      if (!["Instant", "PlainDate", "PlainDateTime", "PlainTime", "ZonedDateTime"].includes(type)) throw new TypeError(`TOML.stringify cannot serialize Temporal.${type} (it has no TOML representation)`);
      if (type === "ZonedDateTime" && v.offsetNanoseconds % 60000000000) v = v.toInstant();
      text = v.toString({ calendarName: "never", timeZoneName: "never" });
    }
    if (type === "PlainTime" || /^\d{4}-/.test(text)) return text;
    if (type === "Instant" || type === "ZonedDateTime") {
      const instant = type === "Instant" ? v : v.toInstant();
      const min = globalThis.Temporal.Instant.from("0000-01-01T00:00:00Z");
      const max = globalThis.Temporal.Instant.from("9999-12-31T23:59:59.999999999Z");
      const early = instant.epochNanoseconds < min.epochNanoseconds;
      const delta = early ? min.epochNanoseconds - instant.epochNanoseconds : instant.epochNanoseconds - max.epochNanoseconds;
      const minutes = Math.min(1439, Math.ceil(Number(delta) / 3600000000000) * 60);
      const offset = (early ? "+" : "-") + String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
      text = instant.toZonedDateTimeISO(offset).toString({ calendarName: "never", timeZoneName: "never" });
      if (/^\d{4}-/.test(text)) return text;
    }
    throw new TypeError(`TOML.stringify cannot serialize a ${name} outside years 0000-9999`);
  }
  function tomlStringify(value, replacer, _space) {
    if (omitted(value)) return undefined;
    if (replacer != null) throw new TypeError("TOML.stringify does not support the replacer argument");
    value = unbox(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date || temporalType(value)) throw new TypeError("TOML.stringify expects an object at the top level (a TOML document is a table)");
    const visiting = new Set();
    function enter(v) {
      if (visiting.has(v)) throw new TypeError("Converting circular structure to TOML");
      visiting.add(v);
    }
    function inline(v, key, inArray) {
      v = unbox(v);
      if (inArray && (v === null || omitted(v))) throw new TypeError(`TOML cannot represent ${v === null ? "null" : typeof v} in an array`);
      if (v === null) throw new TypeError(`TOML cannot represent null (key '${key}'); remove the key or use a sentinel value`);
      if (typeof v === "number") {
        if (Object.is(v, -0)) return "-0.0";
        const text = number(v, "TOML");
        return Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER && !/[.eE]/.test(text) ? text + ".0" : text;
      }
      if (typeof v === "bigint") throw new TypeError("TOML.stringify cannot serialize BigInt");
      if (typeof v === "string") return tomlQuote(v);
      if (typeof v === "boolean") return String(v);
      if (v instanceof Date || temporalType(v)) return tomlDate(v, temporalType(v));
      if (typeof v !== "object") return undefined;
      enter(v);
      const pairs = entries(v);
      const text = Array.isArray(v) ? "[" + Array.from(v, (item) => inline(item, key, true)).join(", ") + "]" : pairs.length ? "{ " + pairs.map((e) => tomlKey(e[0]) + " = " + inline(e[1], e[0], false)).join(", ") + " }" : "{}";
      visiting.delete(v);
      return text;
    }
    const lines = [];
    function header(path, array) {
      if (lines.length) lines.push("");
      lines.push((array ? "[[" : "[") + path.join(".") + (array ? "]]" : "]"));
    }
    function table(v, path, kind) {
      enter(v);
      const pairs = entries(v);
      const scalar = pairs.filter((e) => !subtable(e[1]) && !tables(e[1]));
      if (kind === "array" || (kind === "table" && (scalar.length || !pairs.length))) header(path, kind === "array");
      for (const [k, child] of scalar) lines.push(tomlKey(k) + " = " + inline(child, k, false));
      for (const [k, child] of pairs) section(child, path.concat([tomlKey(k)]));
      visiting.delete(v);
    }
    function subtable(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !temporalType(v) && v === unbox(v); }
    function tables(v) { return Array.isArray(v) && v.length > 0 && v.every(subtable); }
    function section(v, path) {
      if (subtable(v)) { table(v, path, "table"); return; }
      if (!tables(v)) return;
      enter(v);
      for (const item of v) table(item, path, "array");
      visiting.delete(v);
    }
    table(value, [], "root");
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  const TOML = { parse(input) { return parse(input, "TOML"); }, stringify: tomlStringify };
  const YAML = { parse(input) { return parse(input, "YAML"); }, stringify: yamlStringify };
  const JSON5 = { parse(input) { return parse(input, "JSON5"); }, stringify: json5Stringify };
  const JSONC = { parse(input) { return parse(input, "JSONC"); } };
  return { TOML, YAML, JSON5, JSONC, hydrate, parse };
})
