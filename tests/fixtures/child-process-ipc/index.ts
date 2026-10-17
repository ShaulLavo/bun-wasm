import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
for (const kind of ["fork", "spawn"]) {
  const child = kind === "fork" ? fork("./child.ts", [], { silent: true }) : spawn(process.execPath, ["./child.ts"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("error", error => { throw error; });
  child.stderr?.on("data", data => process.stderr.write(data));
  const messages: any[] = [];
  child.on("message", message => {
    messages.push(message);
    if (messages.length === 1) child.send({ text: "x".repeat(2 * 1024 * 1024), n: 17 }, error => assert.equal(error, null));
    else child.disconnect();
  });
  let disconnected = false;
  child.on("disconnect", () => { disconnected = true; assert.equal(child.connected, false); });
  await new Promise<void>(resolve => child.on("close", code => { assert.equal(code, 0); resolve(); }));
  assert.equal(disconnected, true);
  assert.deepEqual(messages, [{ ready: true }, { length: 2097152, n: 17 }]);
  console.log(kind, "IPC round trip and disconnect pass");
}
