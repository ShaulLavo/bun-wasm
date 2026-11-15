type CompletionCase = readonly [label: string, source: string, expected: number | undefined];

const cases: readonly CompletionCase[] = [
  ["constant false", "11; if (0) { 12; }", undefined],
  ["dynamic false", "var c = false; 11; if (c) { 12; }", undefined],
  ["constant empty then", "13; if (1) { }", undefined],
  ["dynamic empty then", "var c = true; 13; if (c) { }", undefined],
  ["constant empty else", "13; if (0) { 14; } else { }", undefined],
  ["dynamic empty else", "var c = false; 13; if (c) { 14; } else { }", undefined],
  ["constant declaration", "13; if (1) { let a = 1; }", undefined],
  ["dynamic declaration", "var c = true; 13; if (c) { let a = 1; }", undefined],
  ["constant break", "while (true) { 16; if (1) break; }", undefined],
  ["dynamic break", "var c = true; while (c) { 16; if (c) break; }", undefined],
  ["constant break else", "while (true) { 17; if (1) break; else 18; }", undefined],
  ["dynamic break else", "var c = true; while (c) { 17; if (c) break; else 18; }", undefined],
  ["constant continue", "for (var i = 0; i < 2; i++) { 19; if (1) continue; }", undefined],
  ["dynamic continue", "var c = true; for (var i = 0; i < 2; i++) { 19; if (c) continue; }", undefined],
  ["constant labelled break", "X: { 9; if (1) { break X; } 10; }", undefined],
  ["dynamic labelled break", "var c = true; X: { 9; if (c) { break X; } 10; }", undefined],
  ["constant else if", "21; if (0) { 22; } else if (1) { }", undefined],
  ["dynamic else if", "var c = false; 21; if (c) { 22; } else if (!c) { }", undefined],
  ["constant nested false", "21; if (1) { 22; if (0) { 23; } }", undefined],
  ["dynamic nested false", "var c = true; 21; if (c) { 22; if (!c) { 23; } }", undefined],
  ["bare block", "13; { }", 13],
  ["bare break", "while (true) { 16; break; }", 16],
  ["bare continue", "for (var i = 0; i < 2; i++) { 19; continue; }", 19],
  ["constant value then", "13; if (1) { 14; }", 14],
  ["dynamic value then", "var c = true; 13; if (c) { 14; }", 14],
  ["constant value else", "13; if (0) { 14; } else { 15; }", 15],
  ["dynamic value else", "var c = false; 13; if (c) { 14; } else { 15; }", 15],
  ["value before break", "X: { 9; if (1) { 10; break X; } }", 10],
  ["value before continue", "for (var i = 0; i < 2; i++) { if (1) { 20 + i; continue; } }", 21],
  ["hoisted declaration", "13; if (1) { } else { var hoisted; }", undefined],
  ["else if value", "21; if (0) { 22; } else if (0) { 23; } else { 24; }", 24],
  ["else if hoist", "21; if (0) { 22; } else if (0) { var hoisted; } else if (1) { }", undefined],
  ["shadowed undefined", "let undefined = 99; 11; if (0) { 12; }", undefined],
];

const indirectEval = eval;
for (const [label, source, expected] of cases) {
  const direct = eval(source);
  const indirect = indirectEval(source);
  if (!Object.is(direct, expected) || !Object.is(indirect, expected)) {
    throw new Error(`${label}: expected ${expected}, direct ${direct}, indirect ${indirect}`);
  }
  console.log(`${label}: ${expected}`);
}

function returnThroughIf(condition: boolean): number {
  if (condition) return 27;
  return 28;
}
if (returnThroughIf(true) !== 27 || returnThroughIf(false) !== 28) throw new Error("function return");
console.log("function returns: preserved");
