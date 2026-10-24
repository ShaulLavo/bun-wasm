// Token stopping and separator rules adapted from Bun WebKit LiteralParser.cpp.
// Upstream revision and license are in docs/bun-patches.md#jsonl-streaming-tokens.
// Complete values still use Bun's Rust parser.
(function (internal: BunWasm.Internal) {
  "use strict";
  type State = "value" | "key" | "firstKey" | "colon" | "afterArray" | "afterObject" | "firstValue" | "complete";
  type Fail = { kind: "error" } | { kind: "incomplete" };
  type Token = { kind: "value" | "string" | "punctuation" | "invalid"; end: number };
  type Scan = Token | Fail;
  type Step = { kind: "step"; end: number; state: State; open?: State; close?: true } | Fail;
  const native = internal.native;
  const formats = internal.require("formats");
  const ws = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t";
  const failAt = (s: string, end: number): Fail => ({ kind: end === s.length ? "incomplete" : "error" });

  function stringToken(s: string, i: number): Scan {
    for (let p = i + 1; p < s.length; p++) {
      if (s[p] === '"') return { kind: "string", end: p + 1 };
      if (s.charCodeAt(p) < 32) return { kind: "error" };
      if (s[p] !== "\\") continue;
      p++;
      if (p === s.length) return { kind: "incomplete" };
      if (s[p] !== "u" && !'"\\/bfnrt'.includes(s[p])) return { kind: "error" };
      if (s[p] !== "u") continue;
      if (!/^[0-9a-fA-F]{4}$/.test(s.slice(p + 1, p + 5))) return { kind: "error" };
      p += 4;
    }
    return { kind: "incomplete" };
  }

  function numberToken(s: string, i: number): Scan {
    const integer = /^-?(?:0|[1-9][0-9]*)/.exec(s.slice(i));
    if (!integer) return failAt(s, i + 1);
    let end = i + integer[0].length;
    if (s[end] === ".") {
      const fraction = /^\.[0-9]+/.exec(s.slice(end));
      if (!fraction) return failAt(s, end + 1);
      end += fraction[0].length;
    }
    const exponent = /^[eE][-+]?[0-9]+/.exec(s.slice(end));
    if (exponent) end += exponent[0].length;
    return { kind: "value", end };
  }

  function lex(s: string, i: number): Scan {
    const c = s[i];
    if (c === '"') return stringToken(s, i);
    if (c === "-" || (c >= "0" && c <= "9")) return numberToken(s, i);
    const word = c === "t" ? "true" : c === "f" ? "false" : c === "n" ? "null" : null;
    if (word && s.startsWith(word, i)) return { kind: "value", end: i + word.length };
    if ("{}[]:(),.=;".includes(c)) return { kind: "punctuation", end: i + 1 };
    const identifier = /^[A-Za-z_$][\w$\u200c\u200d]*/.exec(s.slice(i));
    return { kind: "invalid", end: i + (identifier ? identifier[0].length : 0) };
  }

  function keyToken(s: string, i: number, state: State, token: Token): Step {
    if (s[i] === "}" && state === "firstKey") return { kind: "step", end: token.end, state: "complete", close: true };
    if (token.kind !== "string") return failAt(s, token.end);
    return { kind: "step", end: token.end, state: "colon" };
  }
  function afterToken(s: string, i: number, state: State, token: Token): Step {
    const array = state === "afterArray";
    if (s[i] === (array ? "]" : "}")) return { kind: "step", end: token.end, state: "complete", close: true };
    if (s[i] === ",") return { kind: "step", end: token.end, state: array ? "value" : "key" };
    return failAt(s, token.end);
  }
  function step(s: string, i: number, state: State, token: Token): Step {
    if (state === "key" || state === "firstKey") return keyToken(s, i, state, token);
    if (state === "colon") return s[i] === ":" ? { kind: "step", end: token.end, state: "value" } : failAt(s, token.end);
    if (state === "afterArray" || state === "afterObject") return afterToken(s, i, state, token);
    if (state === "firstValue" && s[i] === "]") return { kind: "step", end: token.end, state: "complete", close: true };
    if (s[i] === "{" || s[i] === "[") return { kind: "step", end: token.end, state: s[i] === "{" ? "firstKey" : "firstValue", open: s[i] === "{" ? "afterObject" : "afterArray" };
    if (token.kind === "value" || token.kind === "string") return { kind: "step", end: token.end, state: "complete" };
    return failAt(s, token.end);
  }
  function one(s: string, start: number): Scan {
    const stack: State[] = [];
    let i = start, state: State = "value";
    while (true) {
      while (ws(s[i])) i++;
      if (i >= s.length) return { kind: "incomplete" };
      const token = lex(s, i);
      if (token.kind === "error" || token.kind === "incomplete") return token;
      const next = step(s, i, state, token);
      if (next.kind !== "step") return next;
      i = next.end;
      state = next.state;
      if (next.open) stack.push(next.open);
      if (next.close) stack.pop();
      if (state !== "complete") continue;
      if (!stack.length) return { kind: "value", end: i };
      state = stack[stack.length - 1];
    }
  }

  function separator(s: string, start: number): number {
    let i = start;
    while (i < s.length && ws(s[i]) && s[i] !== "\n") i++;
    return i === s.length || s[i] === "\n" ? i : -1;
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
      if (token.kind === "error" || token.kind === "incomplete") { done = false; error = token.kind === "error" ? new SyntaxError("Failed to parse JSONL") : null; break; }
      try { values.push(formats.parse(text.slice(cursor, token.end), "JSON")); }
      catch { error = new SyntaxError("Failed to parse JSONL"); done = false; break; }
      read = token.end;
      cursor = separator(text, read);
      if (cursor < 0) { error = new SyntaxError("Failed to parse JSONL"); done = false; break; }
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
