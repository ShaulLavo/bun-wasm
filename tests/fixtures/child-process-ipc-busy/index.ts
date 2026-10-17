import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", 'process.send("ready"); while (true) {}'], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const closed = new Promise<void>(resolve => child.on("close", () => resolve()));
await new Promise<void>(resolve => {
  child.on("message", message => { assert.equal(message, "ready"); child.disconnect(); });
  child.on("disconnect", () => { assert.equal(child.connected, false); resolve(); });
  child.on("error", error => { throw error; });
});
child.kill("SIGKILL");
await closed;
console.log("IPC disconnect does not wait for child");
