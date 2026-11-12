export const computationControl = `
const { spawn } = require("node:child_process");
function lifecycleProfileRoot() {
  const end = Date.now() + 2000;
  let sum = 0;
  while (Date.now() < end) for (let i = 0; i < 100000; i++) sum = (sum + Math.imul(i, 7)) | 0;
  return sum;
}
function lifecycleProfileChild() { return lifecycleProfileRoot(); }
async function main() {
  if (process.argv.includes("child")) {
    console.log("PROFILE_CHILD", process.pid, process.execPath, lifecycleProfileChild());
    return;
  }
  console.log("PROFILE_ROOT", process.pid, process.execPath, lifecycleProfileRoot());
  const child = spawn(process.execPath, [process.argv[1], "child"], { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw new Error("Child control failed: " + code);
  console.log("PROFILE_CONTROL_DONE");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;
