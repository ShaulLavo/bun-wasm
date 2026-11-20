import crypto from "node:crypto";
import { liveCipherCount } from "bun:internal-for-testing";

// A cipher dropped before final() releases its BoringSSL context when it is collected,
// and final() releases it at once. bun-wasm only: the count is runtime-internal.
const key = Buffer.alloc(16, 1);
const iv = Buffer.alloc(12, 2);
const before = liveCipherCount();
const dropped = 1000;

(function drop() {
  for (let i = 0; i < dropped; i++) crypto.createCipheriv("aes-128-gcm", key, iv).update("x");
})();
console.log("dropped ciphers live", liveCipherCount() - before);

// FinalizationRegistry callbacks run from the event loop after a collection.
for (let round = 0; round < 50 && liveCipherCount() - before > dropped / 100; round++) {
  Bun.gc(true);
  await new Promise(resolve => setTimeout(resolve, 0));
}
const left = liveCipherCount() - before;
console.log("dropped ciphers finalized", left <= dropped / 100);

const finished = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
finished.update("x");
console.log("live while open", liveCipherCount() - before - left);
finished.final();
console.log("live after final", liveCipherCount() - before - left);
const failed = crypto.createDecipheriv("aes-128-gcm", key, iv);
failed.update("x");
try {
  failed.final();
} catch {
  console.log("live after a failed final", liveCipherCount() - before - left);
}
