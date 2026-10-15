// JSONL is a streaming JSON parser in native Bun's JSC bindings. Keep token
// boundaries and progress here, and parse each complete value with Bun's Rust parser.
(function (internal) {
  "use strict";
  const native = internal.native;
  const formats = internal.require("formats");
  const ws = (c) => c === " " || c === "\n" || c === "\r" || c === "\t";

  function stringToken(s, i) {
    for (let p = i + 1; p < s.length; p++) {
      if (s[p] === '"') return { end: p + 1 };
      if (s.charCodeAt(p) < 32) return { error: true };
      if (s[p] !== "\\") continue;
      p++;
      if (p === s.length) return { incomplete: true };
      if (s[p] !== "u" && !'"\\/bfnrt'.includes(s[p])) return { error: true };
      if (s[p] === "u") {
        const part = s.slice(p + 1, p + 5);
        if (!/^[0-9a-fA-F]*$/.test(part)) return { error: true };
        if (part.length < 4) return { incomplete: true };
        p += 4;
      }
    }
    return { incomplete: true };
  }

  function scalar(s, i) {
    const c = s[i];
    if (c === '"') return stringToken(s, i);
    const word = c === "t" ? "true" : c === "f" ? "false" : c === "n" ? "null" : null;
    if (word) {
      const part = s.slice(i, i + word.length);
      if (!word.startsWith(part)) return { error: true };
      return part.length < word.length ? { incomplete: true } : { end: i + word.length };
    }
    if (c !== "-" && !(c >= "0" && c <= "9")) return { error: true };
    const rest = s.slice(i);
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/.exec(rest);
    if (!token) return rest === "-" ? { incomplete: true } : { error: true };
    const end = i + token[0].length;
    if ((s[end] === "." || s[end] === "e" || s[end] === "E") && /^(?:\.[0-9]*)?(?:[eE][-+]?[0-9]*)?$/.test(s.slice(end))) return { incomplete: true };
    return { end };
  }

  function keyToken(s, i, state) {
    if (s[i] === "}" && state === "firstKey") return { end: i + 1, state: "complete", close: true };
    if (s[i] !== '"') return { error: true };
    return Object.assign(stringToken(s, i), { state: "colon" });
  }
  function afterToken(s, i, state) {
    const array = state === "afterArray";
    if (s[i] === (array ? "]" : "}")) return { end: i + 1, state: "complete", close: true };
    if (s[i] === ",") return { end: i + 1, state: array ? "value" : "key" };
    return { error: true };
  }
  function step(s, i, state) {
    if (state === "key" || state === "firstKey") return keyToken(s, i, state);
    if (state === "colon") return s[i] === ":" ? { end: i + 1, state: "value" } : { error: true };
    if (state === "afterArray" || state === "afterObject") return afterToken(s, i, state);
    if (state === "firstValue" && s[i] === "]") return { end: i + 1, state: "complete", close: true };
    if (s[i] === "{" || s[i] === "[") return { end: i + 1, state: s[i] === "{" ? "firstKey" : "firstValue", open: s[i] === "{" ? "afterObject" : "afterArray" };
    return Object.assign(scalar(s, i), { state: "complete" });
  }
  function one(s, start) {
    const stack = [];
    let i = start, state = "value";
    while (true) {
      while (ws(s[i])) i++;
      if (i >= s.length) return { incomplete: true };
      const token = step(s, i, state);
      if (!token.end) return token;
      i = token.end;
      state = token.state;
      if (token.open) stack.push(token.open);
      if (token.close) stack.pop();
      if (state !== "complete") continue;
      if (!stack.length) return { end: i };
      state = stack[stack.length - 1];
    }
  }

  function parseChunk(input, start, end) {
    if (input == null) throw new TypeError("JSONL.parseChunk requires a string argument");
    const bytes = ArrayBuffer.isView(input) && !(input instanceof DataView);
    let source = bytes ? internal.toUint8(input) : String(input);
    const length = source.length;
    start = typeof start === "number" && start > 0 ? Math.min(Math.trunc(start), length) : 0;
    end = typeof end === "number" && end >= 0 ? Math.min(Math.trunc(end), length) : length;
    start = Math.min(start, end);
    source = source.slice(start, end);
    let bom = 0;
    if (bytes && start === 0 && source[0] === 239 && source[1] === 187 && source[2] === 191) { source = source.subarray(3); bom = 3; }
    const text = bytes ? native.utf8Decode(source) : source;
    const values = [];
    let cursor = 0, read = 0, error = null, done = true;
    while (cursor < text.length) {
      while (ws(text[cursor])) cursor++;
      if (cursor === text.length) break;
      const token = one(text, cursor);
      if (!token.end) { done = false; if (token.error) error = new SyntaxError("Failed to parse JSONL"); break; }
      try { values.push(formats.parse(text.slice(cursor, token.end), "JSON")); }
      catch { error = new SyntaxError("Failed to parse JSONL"); done = false; break; }
      read = token.end;
      cursor = read;
    }
    return { values, read: start + bom + (bytes ? native.utf8Encode(text.slice(0, read)).length : read), done, error };
  }
  function parse(input) {
    if (input == null) throw new TypeError("JSONL.parse requires a string argument");
    const result = parseChunk(input);
    if (result.error && !result.values.length) throw result.error;
    return result.values;
  }
  const JSONL = { parse, parseChunk };
  Object.defineProperty(JSONL, Symbol.toStringTag, { value: "JSONL", configurable: true });
  return JSONL;
})
