let deepest = 0;
function descend(level: number): number {
  deepest = level;
  return descend(level + 1) + 1;
}
let caught = "nothing";
try { descend(1); }
catch (error) { caught = error instanceof RangeError ? "RangeError" : String(error); }
let again = 0;
try { descend(1); }
catch { again = deepest; }
console.log(JSON.stringify({ caught, deepest, again, recovered: 6 * 7 }));
