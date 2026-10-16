import assert from "node:assert/strict";
import {startEngineHost} from "../src/engine-host.js";
const memory = new WebAssembly.Memory({initial:1, maximum:2});
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function encode(value) {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([7]), u32(bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([9]), u32(value.length)].concat(value.map(encode)));
  const entries = Object.entries(value);
  const fields = entries.flatMap(([key, item]) => [u32(Buffer.byteLength(key)), Buffer.from(key), encode(item)]);
  return Buffer.concat([Buffer.from([10]), u32(entries.length)].concat(fields));
}
const put = value => new Uint8Array(memory.buffer).set(encode(value));
const source = `(function(native) {
  return {
    runMain() {
      native.subtleCrypto.importKey("raw", new Uint8Array([1,2,3]), "PBKDF2", false, ["deriveBits"])
        .then(key => native.subtleCrypto.deriveBits({name:"PBKDF2", hash:"SHA-256", salt:new Uint8Array([4,5]), iterations:50000}, key, 128))
        .then(() => { globalThis.__cryptoSettled = true; });
      return Promise.resolve();
    },
    runTimers: () => -1, ioPending: () => 0, emitBeforeExit: () => false,
    beforeExit: () => 0, handleRejection: error => { throw error; }, handleUncaught: error => { throw error; }
  };
})`;
let settledAtExit;
await startEngineHost({instance:{exports:{
  memory, bunwasm_alloc:() => 32768, bunwasm_result_ptr:() => 0,
  bunwasm_describe() {put({natives:["polyfillSource", "flushOutput", "writeStderr"], constants:{hostCaps:{}}, entry:{kind:"run", main:"/main.js"}});},
  bunwasm_call(index) {put(index === 0 ? source : undefined); return 0;},
}}, onExit(code) { assert.equal(code, 0); settledAtExit = globalThis.__cryptoSettled === true; }});
assert.equal(settledAtExit, true, "host exited before native SubtleCrypto settled");
console.log("native SubtleCrypto keeps the host alive");
