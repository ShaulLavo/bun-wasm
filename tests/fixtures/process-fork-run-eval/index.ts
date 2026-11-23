// `bun run -e CODE -b entry` keeps the flags and their values in process.execArgv, runs the entry,
// and a forked child loads its own entry instead of replaying the eval code.
import { fork } from "node:child_process";

console.log("parent execArgv", JSON.stringify(process.execArgv));
console.log("parent argv", JSON.stringify(process.argv.slice(2)));

const child = fork("./child.ts", ["x"], { silent: true });
let output = "";
child.stdout!.on("data", chunk => (output += chunk));
child.on("exit", code => {
  console.log("child exit", code);
  process.stdout.write(output);
});
