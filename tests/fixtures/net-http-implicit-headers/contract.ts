import assert from "node:assert/strict";

export const headerCases = ["implicit", "flush", "write", "end", "explicit", "retry"];

function call(target: object, name: string, args: unknown[] = []): unknown {
  const method: unknown = Reflect.get(target, name);
  assert.equal(typeof method, "function", `${name} is callable`);
  assert.ok(typeof method === "function");
  return Reflect.apply(method, target, args);
}

export function verifyHeaderRetry(response: object) {
  const writeHead: unknown = Reflect.get(response, "writeHead");
  assert.ok(typeof writeHead === "function");
  const failure = new Error("header hook failed");
  Reflect.set(response, "writeHead", () => { throw failure; });
  assert.throws(() => call(response, "end", ["body"]), error => error === failure);
  assert.equal(Reflect.get(response, "_header"), null);
  assert.equal(Reflect.get(response, "headersSent"), false);
  assert.equal(Reflect.get(response, "_implicitFraming"), undefined);
  Reflect.set(response, "writeHead", writeHead);
}

export function verifyHeaderValidation(response: object) {
  assert.throws(() => call(response, "setHeader", ["Bad Header", "value"]), { code: "ERR_INVALID_HTTP_TOKEN" });
  assert.throws(() => call(response, "setHeader", ["X-Bad", "line\r\nbreak"]), { code: "ERR_INVALID_CHAR" });
  assert.throws(() => call(response, "writeHead", [99]), { code: "ERR_HTTP_INVALID_STATUS_CODE" });
  assert.equal(Reflect.get(response, "_header"), null);
  assert.equal(Reflect.get(response, "headersSent"), false);
}

export function verifyResponseHeaders(response: object, mode: string): string {
  assert.equal(typeof Reflect.get(response, "_implicitHeader"), "function");
  assert.equal(Reflect.get(response, "_header"), null);
  assert.equal(Reflect.get(response, "headersSent"), false);
  verifyHeaderValidation(response);
  if (mode === "retry") verifyHeaderRetry(response);
  const writeHead: unknown = Reflect.get(response, "writeHead");
  assert.ok(typeof writeHead === "function");
  let calls = 0;
  Reflect.set(response, "writeHead", function(this: object, ...args: unknown[]) {
    calls += 1;
    if (calls === 1) {
      call(this, "setHeader", ["X-Prepared", "before-serialization"]);
      call(this, "setHeader", ["Content-Encoding", "identity"]);
      Reflect.set(this, "statusCode", 202);
      args[0] = Reflect.get(this, "statusCode");
    }
    return Reflect.apply(writeHead, this, args);
  });
  Reflect.set(response, "statusCode", 201);
  call(response, "setHeader", ["X-Original", "retained"]);
  if (mode === "implicit") assert.equal(call(response, "_implicitHeader"), undefined);
  if (mode === "explicit") assert.equal(call(response, "writeHead", [201]), response);
  if (mode === "flush") assert.equal(call(response, "flushHeaders"), undefined);
  if (mode === "write") call(response, "write", ["body"]);
  if (mode === "end" || mode === "retry") assert.equal(call(response, "end", ["body"]), response);
  assert.equal(calls, 1, `${mode} invokes wrapped writeHead once`);
  const header: unknown = Reflect.get(response, "_header");
  assert.ok(typeof header === "string");
  assert.match(header, /^HTTP\/1\.1 202 Accepted\r\n/);
  assert.match(header, /X-Prepared: before-serialization\r\n/i);
  assert.match(header, /X-Original: retained\r\n/i);
  assert.match(header, /Content-Encoding: identity\r\n/i);
  assert.ok(header.endsWith("\r\n\r\n"));
  if (mode === "end" || mode === "retry") assert.match(header, /Content-Length: 4\r\n/i);
  assert.equal(Reflect.get(response, "headersSent"), true);
  assert.throws(() => call(response, "setHeader", ["X-Late", "forbidden"]), { code: "ERR_HTTP_HEADERS_SENT" });
  assert.throws(() => call(response, "removeHeader", ["X-Original"]), { code: "ERR_HTTP_HEADERS_SENT" });
  call(response, "flushHeaders");
  call(response, "flushHeaders");
  assert.equal(calls, 1, "repeated flush does not regenerate headers");
  if (mode !== "end" && mode !== "retry") call(response, "end", [mode === "write" ? "tail" : "body"]);
  assert.equal(call(response, "end"), response);
  assert.equal(calls, 1, "repeated end does not regenerate headers");
  assert.equal(Reflect.get(response, "_header"), header);
  assert.throws(() => call(response, "_implicitHeader"), { code: "ERR_HTTP_HEADERS_SENT" });
  return mode === "write" ? "bodytail" : "body";
}
