import assert from "node:assert/strict";
import { Readable } from "node:stream";
import http from "node:http";

type CreateRequest = (body: unknown, method?: string) => object;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const payload = '{"text":"π🙂"}';

function call(target: object, name: string, args: unknown[] = []): unknown {
  const method: unknown = Reflect.get(target, name);
  assert.ok(typeof method === "function", `${name} is callable`);
  return Reflect.apply(method, target, args);
}

function object(value: unknown): object {
  assert.ok(value !== null && typeof value === "object");
  return value;
}

async function consumed(request: object) {
  assert.equal(Reflect.get(request, "bodyUsed"), true);
  await assert.rejects(async () => call(request, "text"), { name: "TypeError" });
}

async function verifyText(create: CreateRequest, body: unknown, expected: string) {
  const request = create(body);
  assert.equal(Reflect.get(request, "bodyUsed"), false);
  const headers = object(Reflect.get(request, "headers"));
  assert.equal(call(headers, "get", ["content-type"]), "application/json");
  assert.equal(await call(request, "text"), expected);
  await consumed(request);
}

async function verifyByteChunks(create: CreateRequest) {
  const request = create({ async *[Symbol.asyncIterator]() { yield "π"; yield encoder.encode("🙂"); } });
  const body = object(Reflect.get(request, "body"));
  assert.equal(Reflect.get(request, "bodyUsed"), false);
  const reader = object(call(body, "getReader"));
  const bytes: Uint8Array[] = [];
  for (;;) {
    const result = object(await call(reader, "read"));
    if (Reflect.get(result, "done")) break;
    const value: unknown = Reflect.get(result, "value");
    assert.ok(value instanceof Uint8Array, "Request body exposes byte chunks");
    bytes.push(value);
  }
  call(reader, "releaseLock");
  assert.equal(decoder.decode(Buffer.concat(bytes)), "π🙂");
  await consumed(request);
}

async function verifyArrayBuffer(create: CreateRequest) {
  const bytes = encoder.encode(payload);
  const backing = new Uint8Array(bytes.length + 2);
  backing.set(bytes, 1);
  const request = create({ async *[Symbol.asyncIterator]() { yield backing.subarray(1, bytes.length + 1); } });
  const reading = call(request, "arrayBuffer");
  assert.equal(Reflect.get(request, "bodyUsed"), true, "consumption marks bodyUsed before awaiting bytes");
  const buffer: unknown = await reading;
  assert.ok(buffer instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(buffer), bytes);
  await consumed(request);
}

async function verifyClone(create: CreateRequest) {
  const request = create({ async *[Symbol.asyncIterator]() { yield encoder.encode(payload); } });
  const copy = object(call(request, "clone"));
  assert.deepEqual(await call(request, "json"), { text: "π🙂" });
  await consumed(request);
  assert.equal(await call(copy, "text"), payload);
  await consumed(copy);
}

async function verifyErrors(create: CreateRequest) {
  const failure = new Error("body iterator failed");
  const request = create({ async *[Symbol.asyncIterator]() { yield encoder.encode("partial"); throw failure; } });
  await assert.rejects(async () => call(request, "text"), error => error === failure);
  await consumed(request);
  const invalid = create({ async *[Symbol.asyncIterator]() { yield { invalid: true }; } });
  await assert.rejects(async () => call(invalid, "text"), { name: "TypeError" });
  await consumed(invalid);
}

async function verifyCancellation(create: CreateRequest) {
  let returned = 0;
  const request = create({ async *[Symbol.asyncIterator]() {
    try { yield encoder.encode("first"); yield encoder.encode("second"); }
    finally { returned += 1; }
  } });
  const reader = object(call(object(Reflect.get(request, "body")), "getReader"));
  const first = object(await call(reader, "read"));
  assert.equal(Reflect.get(first, "done"), false);
  await call(reader, "cancel", ["stop reading"]);
  assert.equal(returned, 1, "cancellation closes the source iterator once");
  call(reader, "releaseLock");
  await consumed(request);
}

function trackedBody() {
  const state = { acquired: 0, next: 0, returned: 0 };
  const iterator = {
    next() { state.next += 1; return Promise.resolve({ done: false, value: encoder.encode("first") }); },
    return() { state.returned += 1; return Promise.resolve({ done: true }); },
  };
  const body = { [Symbol.asyncIterator]() { state.acquired += 1; return iterator; } };
  return { state, body };
}

async function verifyUnreadCancellation(create: CreateRequest) {
  const { state, body } = trackedBody();
  const request = create(body);
  assert.deepEqual(state, { acquired: 1, next: 0, returned: 0 }, "construction acquires the source without pulling");
  const stream = object(Reflect.get(request, "body"));
  await call(stream, "cancel", ["stop before reading"]);
  assert.deepEqual(state, { acquired: 1, next: 0, returned: 1 }, "unread cancellation returns the original iterator");
  await call(stream, "cancel", ["already closed"]);
  assert.equal(state.returned, 1, "repeated cancellation returns only once");
  await consumed(request);
}

function verifyAcquisitionError(create: CreateRequest) {
  const failure = new Error("iterator acquisition failed");
  assert.throws(() => create({ [Symbol.asyncIterator]() { throw failure; } }), error => error === failure);
}

async function verifyNodeCancellation(create: CreateRequest) {
  const unread = new Readable({ read() { this.push(encoder.encode("first")); } });
  const read = new Readable({ read() { this.push(encoder.encode("first")); } });
  try {
    await call(object(Reflect.get(create(unread), "body")), "cancel", ["unread"]);
    assert.equal(unread.destroyed, false, "Node does not destroy its unstarted Readable iterator");
    const reader = object(call(object(Reflect.get(create(read), "body")), "getReader"));
    await call(reader, "read");
    await call(reader, "cancel", ["read"]);
    call(reader, "releaseLock");
    assert.equal(read.destroyed, true, "cancellation after reading tears down the Node Readable");
  } finally {
    unread.destroy();
    read.destroy();
  }
}

function webBody(bytes: Uint8Array): object {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

async function verifyWebBody(create: CreateRequest, makeStream: (bytes: Uint8Array) => object, bytes: Uint8Array) {
  const stream = makeStream(bytes);
  const request = create(stream);
  assert.equal(Reflect.get(request, "body"), stream, "existing Web stream identity is unchanged");
  assert.equal(await call(request, "text"), payload);
  await consumed(request);
}

export async function verifyRequestBodies(create: CreateRequest, makeStream = webBody) {
  const bytes = encoder.encode(payload);
  await verifyText(create, Readable.from([encoder.encode('{"text":"ui-next"}')]), '{"text":"ui-next"}');
  await verifyText(create, Readable.from([bytes.subarray(0, 10), bytes.subarray(10, 13), bytes.subarray(13)]), payload);
  await verifyText(create, { async *[Symbol.asyncIterator]() { yield "prefix:"; yield bytes; yield ":tail"; } }, `prefix:${payload}:tail`);
  await verifyText(create, { async *[Symbol.asyncIterator]() { yield* []; } }, "");
  await verifyText(create, payload, payload);
  await verifyText(create, bytes.subarray(0), payload);
  await verifyText(create, {}, "[object Object]");
  await verifyWebBody(create, makeStream, bytes);
  await verifyByteChunks(create);
  await verifyArrayBuffer(create);
  await verifyClone(create);
  await verifyErrors(create);
  await verifyCancellation(create);
  await verifyUnreadCancellation(create);
  verifyAcquisitionError(create);
  await verifyNodeCancellation(create);
  for (const method of ["GET", "HEAD"]) assert.throws(() => create(Readable.from([bytes]), method), { name: "TypeError" });
}

async function serveBody(create: CreateRequest, input: http.IncomingMessage, output: http.ServerResponse) {
  assert.equal(input.method, "POST");
  assert.equal(input.headers["content-type"], "application/json");
  const request = create(input, input.method);
  assert.deepEqual(await call(request, "json"), { text: "ui-next" });
  await consumed(request);
  output.writeHead(201, { "content-type": "application/json" });
  output.end('{"items":["ui-next"]}');
}

type PostResult = { statusCode: http.IncomingMessage["statusCode"]; body: string };

function collectBody(response: http.IncomingMessage, resolve: (result: PostResult) => void, reject: (error: Error) => void) {
  let body = "";
  response.on("data", chunk => { body += chunk; });
  response.on("error", reject);
  response.on("end", () => resolve({ statusCode: response.statusCode, body }));
}

function postBody(port: number): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/next", method: "POST", agent: false, headers: { "content-type": "application/json" } }, response => collectBody(response, resolve, reject));
    request.on("error", reject);
    request.write('{"text":');
    request.end('"ui-next"}');
  });
}

export async function verifyIncomingRequestBody(create: CreateRequest) {
  const failures: unknown[] = [];
  const server = http.createServer((request, response) => {
    void serveBody(create, request, response).catch(error => { failures.push(error); response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.deepEqual(await postBody(address.port), { statusCode: 201, body: '{"items":["ui-next"]}' });
    assert.deepEqual(failures, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
