// process.exit() throws a TypeError when process.reallyExit is not callable, after the
// 'exit' listeners ran once; the program then ends normally.
process.on("exit", code => console.log("exit", code, process._exiting));
const results: string[] = [];
for (const value of ["str", undefined, {}]) {
  (process as { reallyExit: unknown }).reallyExit = value;
  try {
    process.exit(0);
    results.push("did not throw");
  } catch (error) {
    results.push(`${error instanceof TypeError} ${error.message}`);
  }
}
console.log(results.join("\n"));
