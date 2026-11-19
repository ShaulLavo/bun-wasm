// process.exitCode validation, and process.exit(): _exiting is set before 'exit', and
// process.reallyExit is called as a method of process with the code the listeners left.
const { writeSync } = require("node:fs");
for (const value of ["potato", 1.2, NaN, Infinity, 2 ** 60]) {
  try {
    process.exitCode = value as number;
    console.log("accepted", value);
  } catch (error) {
    console.log(error.code, error.message);
  }
}
process.exitCode = "5" as unknown as number;
console.log("string code", process.exitCode, typeof process.exitCode);
process.exitCode = 300;
console.log("wrapped code", process.exitCode);
process.exitCode = undefined;
console.log("after undefined", process.exitCode);
const reallyExit = process.reallyExit;
process.reallyExit = function (this: unknown, code: number) {
  writeSync(1, `_exiting=${process._exiting} code=${code} this=${this === process}\n`);
  return reallyExit.call(process, code);
} as typeof process.reallyExit;
process.on("exit", code => {
  writeSync(1, `listener code=${code} exitCode=${process.exitCode}\n`);
  process.exitCode = 42;
});
console.log("_exiting", process._exiting);
process.exit(7);
