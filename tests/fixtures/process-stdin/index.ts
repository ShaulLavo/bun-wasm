import assert from "node:assert/strict";

const eventSource = `
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => console.log("DATA:" + chunk.trim()));
  process.stdin.on("end", () => console.log("EOF"));
  setTimeout(() => console.log("TIMER"), 30);
  console.log("READY");
`;
const iteratorSource = `
  console.log("READY");
  setTimeout(() => console.log("TIMER"), 30);
  for await (const chunk of process.stdin) console.log("DATA:" + String(chunk).trim());
  console.log("EOF");
`;

async function check(source: string) {
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let output = "";
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => child.kill(), 5000);
  async function until(marker: string) {
    while (!output.includes(marker)) {
      const next = await reader.read();
      assert.equal(next.done, false, `child ended before ${marker}: ${output}`);
      output += decoder.decode(next.value, { stream: true });
    }
  }
  try {
    await until("READY\n");
    child.stdin.write("first\n");
    await child.stdin.flush();
    // Both must arrive while the parent's write endpoint is still open.
    await until("DATA:first\n");
    await until("TIMER\n");
    child.stdin.write("second\n");
    await child.stdin.flush();
    await until("DATA:second\n");
    await child.stdin.end();
    await until("EOF\n");
    assert.equal(await child.exited, 0);
  } finally {
    clearTimeout(deadline);
    child.kill();
    await reader.cancel();
    await child.exited;
  }
}
await check(eventSource);
await check(iteratorSource);
console.log("PASS process stdin events and iterator before EOF");
