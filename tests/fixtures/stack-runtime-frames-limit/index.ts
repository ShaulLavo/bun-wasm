// The frames error.stack leaves out do not use up Error.stackTraceLimit: with a small limit, an
// error thrown inside the runtime still names the program's caller, as in Bun.
import fs from "node:fs";

const root = import.meta.dir;
const prefix = root.endsWith("/") ? root : `${root}/`;
function frames(error: unknown) {
  const stack = (error as Error).stack;
  return typeof stack === "string" ? stack.split(prefix).join("./") : `<${typeof stack}>`;
}
function firstProgramFrame(label: string, run: () => unknown) {
  try {
    run();
  } catch (error) {
    const line = frames(error).split("\n").find(text => text.includes("(./") || text.trim().startsWith("at ./"));
    console.log(`${label}: ${line?.trim() ?? "no program frame"}`);
  }
}

Error.stackTraceLimit = 3;
console.log("limit reads back:", Error.stackTraceLimit);
firstProgramFrame("Buffer.alloc", () => {
  Buffer.alloc(-1);
});
firstProgramFrame("fs.readFileSync", () => {
  fs.readFileSync(`${root}/missing`);
});

// The program's own frames are still cut to the limit.
function outer() { middle(); }
function middle() { inner(); }
function inner() { innermost(); }
function innermost() { throw new Error("deep"); }
try { outer(); } catch (error) { console.log(frames(error)); }

// The limit in force when the error is created applies, not the one when stack is first read.
Error.stackTraceLimit = 1;
const early = new Error("early");
Error.stackTraceLimit = 10;
console.log(frames(early));

// A custom formatter receives as many call sites as the limit allows.
Error.stackTraceLimit = 2;
Error.prepareStackTrace = (_error, sites) => `${sites.length} call sites`;
function one() { return two(); }
function two() { return three(); }
function three() { const error = new Error("custom"); return error.stack; }
console.log(one());
Error.prepareStackTrace = undefined;

Error.stackTraceLimit = 0;
console.log("limit 0:", frames(new Error("none")));
