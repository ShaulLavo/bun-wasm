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
async function checkPauseExit() {
  const source = 'process.stdin.on("data", () => {}); setTimeout(() => { process.stdin.pause(); process.stdin.ref(); console.log("PAUSED"); }, 20);';
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill(); }, 5000);
  try {
    assert.equal(await child.exited, 0);
    assert.equal(expired, false, "paused child must exit without EOF");
    assert.equal(await new Response(child.stdout).text(), "PAUSED\n");
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.stdin.end();
    await child.exited;
  }
}
await checkPauseExit();
await check(eventSource);
await check(iteratorSource);
console.log("PASS process stdin events and iterator before EOF");
