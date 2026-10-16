import assert from "node:assert/strict";
const failures = [];
for (const fd of [1, 2]) {
  const name = fd === 2 ? "stderr" : "stdout";
  const child = Bun.spawn([process.execPath, "run", "/child.ts", String(fd)], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  try {
    const reader = child[name].getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel();
    const result = JSON.parse(await new Response(fd === 2 ? child.stdout : child.stderr).text());
    assert.equal(await child.exited, 0);
    assert.deepEqual(result, { order: ["callback", "callback tick", "event"], returned: true, same: true,
      callback: { code: "EPIPE", errno: -32, syscall: "write" }, event: { code: "EPIPE", errno: -32, syscall: "write" } });
    console.log(name, "callback, callback tick, event; EPIPE -32 write");
  } catch (error) { failures.push(name + ": " + error.message); }
  finally { child.kill(); }
}
if (failures.length) throw new Error(failures.join("\n"));
