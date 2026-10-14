console.log("start");
process.on("exit", (code) => console.log("exit code", code));
async function fail() {
  await null;
  throw new Error("async failure");
}
fail();
setTimeout(() => console.log("not reached"), 50);
