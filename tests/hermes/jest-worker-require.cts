const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hermes-jest-require-"));
const workerDirectory = path.join(directory, "node_modules/next/dist/compiled/jest-worker");
const worker = path.join(workerDirectory, "processChild.js");
const replies: unknown[] = [];
const send = Object.getOwnPropertyDescriptor(process, "send");
const listeners = new Set(process.listeners("message"));
const originalCwd = process.cwd();
try {
  fs.mkdirSync(workerDirectory, { recursive: true });
  fs.writeFileSync(path.join(directory, "target.cts"), 'module.exports = { run() { return "wrong cwd"; } };');
  fs.writeFileSync(path.join(workerDirectory, "target.cts"), 'module.exports = { run(value) { return "module-relative " + value; }, teardown() { process.send(["teardown"]); } };');
  fs.copyFileSync(path.join(__dirname, "fixtures/next-jest-worker/processChild.js"), worker);
  Object.defineProperty(process, "send", { configurable: true, writable: true, value: (message: unknown) => { replies.push(message); } });
  process.chdir(directory);
  require(worker);
  process.emit("message", [0, null, "./target.cts", []]);
  process.emit("message", [1, null, "run", ["ok"]]);
  process.emit("message", [2]);
  assert.deepEqual(replies, [[0, "module-relative ok"], ["teardown"]]);
  assert.equal(Object.hasOwn(globalThis, "require"), false);
  console.log("jest-worker module-relative require and teardown ok");
} finally {
  process.chdir(originalCwd);
  for (const listener of process.listeners("message")) {
    if (!listeners.has(listener)) process.removeListener("message", listener);
  }
  if (send) Object.defineProperty(process, "send", send);
  else delete process.send;
  fs.rmSync(directory, { recursive: true, force: true });
}
