const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on("line", (line) => lines.push(line.toUpperCase()));
rl.on("close", () => {
  console.log("lines:", lines.join(" "));
  console.log("count:", lines.length);
});
