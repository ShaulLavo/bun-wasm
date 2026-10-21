import { test, expect } from "bun:test";
import { headerCases, verifyResponseHeaders, verifyHeaderRetry } from "../tests/fixtures/net-http-implicit-headers/contract";
import { responseFixture } from "./node-http-response-fixture";

for (const mode of headerCases) {
  test(`production ServerResponse preserves ${mode} header hooks and exact wire framing`, async () => {
    const fixture = responseFixture();
    const response = fixture.create();
    const body = verifyResponseHeaders(response, mode);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    const header: unknown = Reflect.get(response, "_header");
    expect(typeof header).toBe("string");
    const framed = mode === "end" || mode === "retry" ? body : mode === "write" ? "4\r\nbody\r\n4\r\ntail\r\n0\r\n\r\n" : "4\r\nbody\r\n0\r\n\r\n";
    expect(Buffer.concat(fixture.wire).toString("latin1")).toBe(`${header}${framed}`);
  });
}

test.each(["writeHead", "_implicitHeader"])("production %s prepares headers without sending socket bytes", name => {
  const fixture = responseFixture();
  const response = fixture.create();
  const prepare: unknown = Reflect.get(response, name);
  const flush: unknown = Reflect.get(response, "flushHeaders");
  expect(typeof prepare).toBe("function");
  expect(typeof flush).toBe("function");
  if (typeof prepare !== "function" || typeof flush !== "function") throw new Error("Missing header method");
  expect(Reflect.get(response, "_implicitFraming")).toBeUndefined();
  Reflect.apply(prepare, response, name === "writeHead" ? [200] : []);
  expect(fixture.wire).toEqual([]);
  const header: unknown = Reflect.get(response, "_header");
  expect(typeof header).toBe("string");
  if (typeof header !== "string") throw new Error("Header was not prepared");
  Reflect.apply(flush, response, []);
  Reflect.apply(flush, response, []);
  expect(Buffer.concat(fixture.wire).toString("latin1")).toBe(header);
});

test("throwing production header hook sends no bytes and clears temporary framing", () => {
  const fixture = responseFixture();
  verifyHeaderRetry(fixture.create());
  expect(fixture.wire).toEqual([]);
});
