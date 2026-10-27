import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import promises from "node:dns/promises";

function assertAddresses(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error("expected at least one lookup address");
  for (const result of value) {
    if (typeof result !== "object" || result === null) throw new Error("lookup result is not an object");
    if (!("address" in result) || typeof result.address !== "string") throw new Error("lookup address is not a string");
    if (!("family" in result) || (result.family !== 4 && result.family !== 6)) throw new Error("lookup family is invalid");
    assert.equal(net.isIP(result.address), result.family);
  }
}

assert.equal(dns.promises, promises);
assert.deepEqual(await promises.lookup("127.0.0.1"), { address: "127.0.0.1", family: 4 });
assert.deepEqual(await promises.lookup("127.0.0.1", { family: null as never }), { address: "127.0.0.1", family: 4 });
assert.deepEqual(await promises.lookup("::1", { all: true, verbatim: true }), [{ address: "::1", family: 6 }]);
assert.deepEqual(await promises.lookup("", { all: true }), []);
assert.deepEqual(await promises.lookup("", { family: 6 }), { address: null, family: 4 });
assert.throws(() => promises.lookup({} as never, 4), { code: "ERR_INVALID_ARG_TYPE" });
const callback = new Promise(resolve => dns.lookup("127.0.0.1", 4, (...result: [null, string, number]) => resolve(result)));
assert.deepEqual(await callback, [null, "127.0.0.1", 4]);

assertAddresses(await promises.lookup("localhost", { all: true, verbatim: true }));
const hostnameCallback = new Promise((resolve, reject) => dns.lookup("localhost", { all: true, verbatim: true }, (error: unknown, result: unknown) => {
  if (error !== null) {
    reject(error);
    return;
  }
  resolve(result);
}));
assertAddresses(await hostnameCallback);

let beforeExitLookupStarted = false;
let beforeExitLookupSettled = false;
let cancelledLookupSettled = false;

function assertExitCancellation(code: number): void {
  assert.equal(code, 0);
  assert.equal(beforeExitLookupStarted, true);
  assert.equal(beforeExitLookupSettled, true);
  assert.equal(cancelledLookupSettled, false);
  console.log("DNS lookup native hostname, callback and beforeExit promise lifecycle passed");
  console.log("DNS lookup exit cancellation passed");
}

function scheduleExitCancellation(): void {
  Promise.resolve().then(() => {
    const pending = promises.lookup("localhost", { all: true, verbatim: true });
    pending.then(() => { cancelledLookupSettled = true; }, () => { cancelledLookupSettled = true; });
    process.once("exit", assertExitCancellation);
    process.exit(0);
  });
}

function scheduleBeforeExitLookup(): void {
  Promise.resolve().then(async () => {
    beforeExitLookupStarted = true;
    assertAddresses(await promises.lookup("localhost", { all: true, verbatim: true }));
    beforeExitLookupSettled = true;
    process.once("beforeExit", scheduleExitCancellation);
  });
}

process.once("beforeExit", scheduleBeforeExitLookup);
console.log("DNS lookup literals, overloads, callback delivery and promise identity passed");
