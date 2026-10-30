import assert from "node:assert/strict";

const source = `
  const http = require("node:http");
  const readline = require("node:readline");
  const server = http.createServer((request, response) => response.end("served"));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", line => console.log("LINE:" + line));
  rl.on("close", () => server.close());
  setTimeout(() => console.log("TIMER"), 30);
  server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.address().port));
`;

const child = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const reader = child.stdout.getReader();
const decoder = new TextDecoder();
let output = "";
let expired = false;
const deadline = setTimeout(() => { expired = true; child.kill(); }, 5000);
async function until(marker: string) {
  while (!output.includes(marker)) {
    const next = await reader.read();
    assert.equal(next.done, false, `child ended before ${marker}, deadline expired: ${expired}, output: ${output}`);
    output += decoder.decode(next.value, { stream: true });
  }
}
try {
  await until("PORT:");
  await until("\n");
  const port = output.match(/PORT:(\d+)/)?.[1];
  assert.ok(port, output);
  const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "close" }, signal: AbortSignal.timeout(3000) });
  assert.equal(await response.text(), "served");
  child.stdin.write("first\n");
  await child.stdin.flush();
  await until("LINE:first\n");
  await until("TIMER\n");
  await child.stdin.end();
  assert.equal(await child.exited, 0);
  console.log("PASS readline serves HTTP and delivers lines before stdin EOF");
} finally {
  clearTimeout(deadline);
  child.kill();
  await child.stdin.end();
  await reader.cancel();
  await child.exited;
}
