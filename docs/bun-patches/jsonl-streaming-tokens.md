## JSONL streaming tokens

Class **Port**. `crates/bunwasm-runtime/src/js/jsonl.ts` adapts the token and separator
rules of Bun WebKit's `Source/JavaScriptCore/runtime/LiteralParser.cpp`, specifically
`tryStreamingParse`, `lex`, `lexIdentifier`, `lexStringSlow`, `lexNumber`, and
`parsePrimitiveValue`, at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
`Source/JavaScriptCore/runtime/JSONObject.cpp` exposes `streamingJSONParse` at that
revision. Bun's `src/jsc/bindings/BunObject.cpp` at
`9510e74152073d850a18758ca41114d8f214ffa6` supplies the `jsFunctionJSONLParseChunk`
and `jsFunctionJSONLParse` contracts.

The existing original adapter keeps its iterative container stack, Rust-backed
value materialization, input coercion, UTF-8 byte accounting, and public result
object. The adapted lexer distinguishes an invalid token that stops at end of
input from one that stops earlier. It accepts a complete numeric prefix before an
unfinished exponent, rejects missing decimal digits, and reports short Unicode
escapes as errors. Values commit before a required newline separator is checked.
A final malformed token can therefore return an incomplete result, and
`parse("invalid")` returns an empty array rather than throwing. No JSC allocation,
recursive parser, SIMD fast path, JSON cache, or C++ implementation is copied.

`tests/fixtures/jsonl-parity` is an original native-control regression fixture.
Its expected output comes from installed Bun 1.4.4 and matches the preserved
Bun 1.4.2 control byte-for-byte, including complete result
objects, byte slices, UTF-8 BOMs, and incremental stream replay. The separate
original `runtime-ts-jsonl` and `data-formats` fixtures remain unchanged.

The adapted WebKit algorithm retains its upstream license:

```text
Copyright (C) 2009-2024 Apple Inc. All rights reserved.
Copyright (C) 2012 Mathias Bynens (mathias@qiwi.be)

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

```

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [JSONL streaming tokens](#jsonl-streaming-tokens) | Port | Match Bun WebKit token stopping positions and newline-separated values without replacing Rust value parsing. |

[Ledger scope and pinned revisions](scope.md).
