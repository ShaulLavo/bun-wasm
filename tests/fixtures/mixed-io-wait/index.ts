// Completion coverage on real guests. The component test owns the deterministic wake-cause proof.
const server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
const child = Bun.spawn([process.execPath, "-e", `
let count = 0;
process.stdin.on("data", () => {
  process.stdout.write("pong\\n");
  if (++count === 4) process.exit(0);
});
`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
try {
  let replies = 0;
  child.stdin.write("ping\n");
  for await (const chunk of child.stdout) {
    const text = new TextDecoder().decode(chunk);
    if (text !== "pong\n") throw new Error(`Unexpected child output ${text}`);
    replies++;
    if (replies < 4) child.stdin.write("ping\n");
  }
  if (replies !== 4 || await child.exited !== 0) throw new Error("Mixed I/O completion failed");
  console.log("mixed socket and selected child pipe: four replies, child exit");
} finally { child.kill(); server.stop(true); }
