import assert from "node:assert/strict";

const source = 'console.log(JSON.stringify([process.pid, process.ppid]));';
async function childIdentity() {
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const identity: unknown = JSON.parse(await new Response(child.stdout).text());
    assert.deepEqual(identity, [child.pid, process.pid]);
    assert.equal(await child.exited, 0);
    return child.pid;
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
}
assert.ok(Number.isInteger(process.pid) && process.pid > 0);
const siblings = await Promise.all([childIdentity(), childIdentity()]);
assert.notEqual(siblings[0], siblings[1]);
console.log("PASS assigned process identity and parent-child handles");
