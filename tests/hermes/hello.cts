const { verifyReadlineIteration } = require("../fixtures/readline-async-iterator/verify.ts");
const sum: number = 1 + 1;
verifyReadlineIteration().then(() => console.log("hello", sum), (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
