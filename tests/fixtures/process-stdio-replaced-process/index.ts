const p = process;
const warm = [p.stdout, p.stderr];
let reported = 0;
p.on("uncaughtException", error => {
  reported++;
  console.log("reported", (error as Error).name);
});
(globalThis as { process: unknown }).process = null;
console.log("cached streams", p.stdout === warm[0], p.stderr === warm[1]);
const cold = p.stdin;
console.log("cold read", cold);
setImmediate(() => console.log("reports", reported));
