import assert from "node:assert/strict";
assert.equal(process.connected, true);
process.send!({ ready: true });
process.on("message", (message: any) => process.send!({ length: message.text.length, n: message.n }));
process.on("disconnect", () => assert.equal(process.connected, false));
