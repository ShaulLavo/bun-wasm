// Deeply nested literals must overflow with a catchable RangeError. JSC's parser retried a failed
// `{` or `[` expression as a destructuring pattern even after its stack check had failed, so every
// enclosing level descended to the limit twice. The work doubled per level until an allocation
// failed and the engine crashed at 0xbbadbeef (docs/bun-patches/jsc-parser-overflow-retry.md).
// Each literal is parsed from several stack depths so the overflow lands on different tokens.
// The array holds `void 0` so JSC's JSON fast path in eval cannot accept it without the parser.

// QuickJS on main reports this overflow as `SyntaxError: invalid property name`. Tolerate that
// exact error only where QuickJS's own parser compiles the source; nowhere else.
function quickjsParser(): boolean {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  try { (0, eval)("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return error.message === "'let' is not a valid lexical identifier";
  }
  throw new Error("Invalid lexical declaration was accepted");
}
const quickjs = quickjsParser();

function recover(): void {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  if ((0, eval)("((value) => value + 1)(41)") !== 42) throw new Error("parser did not recover");
}

function accepted(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return quickjs && error instanceof SyntaxError && error.message === "invalid property name";
}

function attempt(literal: string, remaining: number, name: string): void {
  // oxlint-disable-next-line no-eval -- The compiler under test is the runtime's evaluator.
  const parse = (depth: number): unknown => (depth === 0 ? (0, eval)(literal) : parse(depth - 1));
  let caught: unknown;
  try { parse(remaining); } catch (error) { caught = error; }
  if (!accepted(caught)) throw new Error(`${name} literal from depth ${remaining}: ${String(caught)}`);
  recover();
}

const shapes: readonly (readonly [string, string, string, string])[] = [
  ["object", "({a:", "0", "})"],
  ["array", "[", "void 0", "]"],
];
for (const [name, open, inner, close] of shapes) {
  const literal = open.repeat(200000) + inner + close.repeat(200000);
  for (let remaining = 0; remaining < 16; remaining++) attempt(literal, remaining, name);
  console.log(name, "literal overflow is catchable");
}
recover();
console.log("parser recovered");
