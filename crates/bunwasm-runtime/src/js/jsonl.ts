// JSONL is a streaming JSON parser in native Bun's JSC bindings. Keep token
// boundaries and progress here, and parse each complete value with Bun's Rust parser.
(function (internal: BunWasm.Internal) {
  "use strict";
  type State = "value" | "key" | "firstKey" | "colon" | "afterArray" | "afterObject" | "firstValue" | "complete";
  type Fail = { end?: undefined; error?: true; incomplete?: true };
  type Scan = { end: number; error?: undefined } | Fail;
  type Step = { end: number; state: State; open?: State; close?: true } | Fail;
  const native = internal.native;
  const formats = internal.require("formats");
  const ws = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t";
  const tag = (token: Scan, state: State): Step => Object.assign(token, { state });

  function stringToken(s: string, i: number): Scan {
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

  function scalar(s: string, i: number): Scan {
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

  function keyToken(s: string, i: number, state: State): Step {
    if (s[i] === "}" && state === "firstKey") return { end: i + 1, state: "complete", close: true };
    if (s[i] !== '"') return { error: true };
    return tag(stringToken(s, i), "colon");
  }
  function afterToken(s: string, i: number, state: State): Step {
    const array = state === "afterArray";
    if (s[i] === (array ? "]" : "}")) return { end: i + 1, state: "complete", close: true };
    if (s[i] === ",") return { end: i + 1, state: array ? "value" : "key" };
    return { error: true };
  }
  function step(s: string, i: number, state: State): Step {
    if (state === "key" || state === "firstKey") return keyToken(s, i, state);
    if (state === "colon") return s[i] === ":" ? { end: i + 1, state: "value" } : { error: true };
    if (state === "afterArray" || state === "afterObject") return afterToken(s, i, state);
    if (state === "firstValue" && s[i] === "]") return { end: i + 1, state: "complete", close: true };
    if (s[i] === "{" || s[i] === "[") return { end: i + 1, state: s[i] === "{" ? "firstKey" : "firstValue", open: s[i] === "{" ? "afterObject" : "afterArray" };
    return tag(scalar(s, i), "complete");
  }
  function one(s: string, start: number): Scan {
    const stack: State[] = [];
    let i = start, state: State = "value";
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

  function parseChunk(input: unknown, start?: unknown, end?: unknown) {
    if (input == null) throw new TypeError("JSONL.parseChunk requires a string argument");
    const bytes = ArrayBuffer.isView(input) && !(input instanceof DataView) ? internal.toUint8(input) : null;
    let text = bytes ? "" : String(input);
    const length = bytes ? bytes.length : text.length;
    const last = typeof end === "number" && end >= 0 ? Math.min(Math.trunc(end), length) : length;
    const first = Math.min(typeof start === "number" && start > 0 ? Math.min(Math.trunc(start), length) : 0, last);
    let bom = 0;
    if (bytes) {
      let view = bytes.slice(first, last);
      if (first === 0 && view[0] === 239 && view[1] === 187 && view[2] === 191) { view = view.subarray(3); bom = 3; }
      text = native.utf8Decode(view);
    } else text = text.slice(first, last);
    const values: unknown[] = [];
    let cursor = 0, read = 0, error: SyntaxError | null = null, done = true;
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
    return { values, read: first + bom + (bytes ? native.utf8Encode(text.slice(0, read)).length : read), done, error };
  }
  function parse(input: unknown) {
    if (input == null) throw new TypeError("JSONL.parse requires a string argument");
    const result = parseChunk(input);
    if (result.error && !result.values.length) throw result.error;
    return result.values;
  }
  const JSONL = { parse, parseChunk };
  Object.defineProperty(JSONL, Symbol.toStringTag, { value: "JSONL", configurable: true });
  return JSONL;
})
