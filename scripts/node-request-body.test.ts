import { test } from "bun:test";
import assert from "node:assert/strict";
import { verifyRequestBodies, verifyIncomingRequestBody } from "../tests/fixtures/request-body-streams/contract.ts";
import { requestBodyFixture } from "./node-request-body-fixture.ts";

for (const engine of ["host", "portable"] satisfies ("host" | "portable")[]) {
  test(`production Request preserves bodies through the shipped ${engine} streams.js selection`, async () => {
    const fixture = requestBodyFixture(engine);
    const lazy = fixture.create("unused bytes");
    assert.equal(Reflect.get(lazy, "_stream"), null, "byte bodies do not eagerly allocate a stream");
    assert.equal(Reflect.get(lazy, "bodyUsed"), false);
    assert.equal(Reflect.get(lazy, "_stream"), null, "bodyUsed does not allocate a lazy byte stream");
    await verifyRequestBodies(fixture.create, fixture.stream);
  });

  test(`production Request consumes a real Node IncomingMessage with ${engine} streams.js`, async () => {
    await verifyIncomingRequestBody(requestBodyFixture(engine).create);
  });
}

test("host Request keeps the captured native observer after global installation", async () => {
  const fixture = requestBodyFixture("host");
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Request");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  assert.ok(requestDescriptor && fetchDescriptor);
  function unexpectedPlatformCall() { throw new Error("observer used an installed global or fetched"); }
  try {
    Object.defineProperty(globalThis, "Request", { configurable: true, value: unexpectedPlatformCall });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: unexpectedPlatformCall });
    const stream = fixture.stream(new Uint8Array([42]));
    const request = fixture.create(stream);
    assert.equal(Reflect.get(request, "body"), stream);
    assert.ok(stream instanceof ReadableStream);
    const reader = stream.getReader();
    assert.deepEqual((await reader.read()).value, new Uint8Array([42]));
    reader.releaseLock();
    assert.equal(Reflect.get(request, "bodyUsed"), true);
  } finally {
    Object.defineProperty(globalThis, "Request", requestDescriptor);
    Object.defineProperty(globalThis, "fetch", fetchDescriptor);
  }
});
