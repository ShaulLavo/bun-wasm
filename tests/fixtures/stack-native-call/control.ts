for (const mode of ["call", "apply"]) {
  let depth = 0;
  function visit(): number {
    if (++depth === 55) return depth;
    return mode === "call" ? visit.call(undefined) : visit.apply(undefined, []);
  }
  if (visit() !== 55) throw new Error(`${mode} changed its result`);
  console.log(mode, "55 completed");
}
let caught = false;
function overflow(): number { return 1 + overflow.apply(undefined, []); }
try { overflow(); } catch (error) {
  if (!(error instanceof RangeError)) throw error;
  caught = true;
}
if (!caught) throw new Error("native reentry did not throw RangeError");
console.log("native overflow caught");
if ((() => 42).call(undefined) !== 42) throw new Error("native call failed after overflow");
console.log("continued");

import "./semantics";
