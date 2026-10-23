import assert from "node:assert/strict";
import http2, { Http2ServerResponse } from "node:http2";
import { Stream, Writable } from "node:stream";

class ResponseStream extends Writable {
  headersSent = false;
  headRequest = false;
  sent: unknown[] = [];
  hints: unknown[] = [];
  trailers: unknown;
  chunks: string[] = [];
  timeoutValue = 0;
  respond(headers: object, options: object) {
    this.headersSent = true;
    this.sent.push([Object.assign({}, headers), options]);
  }
  additionalHeaders(headers: object) { this.hints.push(headers); }
  sendTrailers(headers: object) { this.trailers = Object.assign({}, headers); }
  _write(chunk: Uint8Array, _encoding: string, callback: () => void) {
    this.chunks.push(Buffer.from(chunk).toString());
    callback();
  }
  setTimeout(value: number, callback?: () => void) {
    this.timeoutValue = value;
    if (callback) this.once("timeout", callback);
    return this;
  }
  pushStream(_headers: object, _options: object, callback: (error: null, stream: ResponseStream) => void) {
    callback(null, new ResponseStream());
  }
}

assert.equal(http2.Http2ServerResponse, Http2ServerResponse);
assert.equal(require("node:http2").Http2ServerResponse, Http2ServerResponse);
assert.equal(new Stream() instanceof Http2ServerResponse, false);
assert.throws(() => new Http2ServerResponse(), TypeError);
const stream = new ResponseStream();
const response = new Http2ServerResponse(stream);
assert.ok(response instanceof Stream);
assert.ok(response instanceof Http2ServerResponse);
assert.equal(Object.getPrototypeOf(Http2ServerResponse.prototype), Stream.prototype);
assert.equal(response.stream, stream);
assert.equal(response.statusCode, 200);
assert.equal(response.sendDate, true);
assert.equal(response.writable, true);
assert.equal(response.headersSent, false);
assert.equal(response.finished, false);
assert.equal(response.writableEnded, false);
assert.equal(response.writableLength, stream.writableLength);
assert.equal(response.writableHighWaterMark, stream.writableHighWaterMark);
assert.equal(response.writableNeedDrain, stream.writableNeedDrain);
assert.equal(response.socket, response.connection);
assert.throws(() => response.socket.write, { code: "ERR_HTTP2_NO_SOCKET_MANIPULATION" });
console.log("http2 class identity and stream inheritance");

response.setHeader(" X-Test ", "old");
response.appendHeader("x-test", ["second", "third"]);
assert.deepEqual(response.getHeader("X-Test"), ["old", "second", "third"]);
assert.equal(Object.getPrototypeOf(response.getHeaders()), null);
const copy = response.getHeaders();
copy.unrelated = "local";
assert.equal(response.hasHeader("unrelated"), false);
assert.throws(() => response.setHeader(7, "x"), { code: "ERR_INVALID_ARG_TYPE" });
assert.throws(() => response.setHeader(":status", 200), { code: "ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED" });
assert.throws(() => response.setHeader("x-null", null), { code: "ERR_HTTP2_INVALID_HEADER_VALUE" });
assert.throws(() => { response.statusCode = 100; }, { code: "ERR_HTTP2_INFO_STATUS_NOT_ALLOWED" });
assert.throws(() => { response.statusCode = 600; }, { code: "ERR_HTTP2_STATUS_INVALID" });
const values = ["a"];
response.setHeader("x-array", values);
response.appendHeader("x-array", ["b"]);
assert.equal(response.getHeader("x-array"), values);
assert.deepEqual(values, ["a", "b"]);
response.removeHeader("x-array");
response.setHeader(":protocol", "websocket");
assert.equal(response.getHeader(":protocol"), "websocket");
response.removeHeader(":protocol");
assert.throws(() => response.setHeader(":other", "x"), { code: "ERR_HTTP2_INVALID_PSEUDOHEADER" });
response.statusCode = 201;
response.removeHeader("date");
assert.equal(response.sendDate, false);
response.setTrailer(" X-Trailer ", "done");
response.addTrailers({ "x-other": "yes" });
let drain = 0;
response.on("drain", () => { drain++; });
stream.emit("drain");
assert.equal(drain, 1);
response.setTimeout(123);
assert.equal(stream.timeoutValue, 123);
assert.equal(response.writeContinue(), true);
assert.equal(response.writeInformation(102, { "x-info": "yes" }), true);
assert.throws(() => response.writeInformation(101, {}), { code: "ERR_HTTP2_STATUS_INVALID" });
assert.equal(response.writeEarlyHints({ link: ["</a.css>; rel=preload", "</b.css>; rel=preload"] }), true);
assert.throws(() => response.writeEarlyHints({ link: "</a>\r\n" }), { code: "ERR_INVALID_ARG_VALUE" });
assert.equal(response.writeEarlyHints({ link: [] }), false);
assert.equal(stream.hints.length, 3);
assert.deepEqual(stream.hints[2], { ":status": 103, Link: "</a.css>; rel=preload, </b.css>; rel=preload" });
assert.equal(response.writeHead(201, ["x-test", "new", "x-test", "last"]), response);
assert.deepEqual(stream.sent, [[{ ":status": 201, "x-test": ["new", "last"] }, { endStream: false, waitForTrailers: true, sendDate: false }]]);
assert.throws(() => response.setHeader("late", "x"), { code: "ERR_HTTP2_HEADERS_SENT" });
assert.throws(() => response.writeHead(202), { code: "ERR_HTTP2_HEADERS_SENT" });
assert.equal(response.writeContinue(), false);
console.log("http2 headers, validation, hints and forwarding");

const events: string[] = [];
response.on("finish", () => { events.push("finish"); });
const closed = new Promise<void>(resolve => response.once("close", () => { events.push("close"); resolve(); }));
response.write("hello ");
stream.emit("wantTrailers");
assert.deepEqual(stream.trailers, { "x-trailer": "done", "x-other": "yes" });
response.end("astro", () => { events.push("callback"); });
assert.equal(response.finished, true);
assert.equal(response.writableEnded, true);
await closed;
assert.deepEqual(stream.chunks, ["hello ", "astro"]);
assert.deepEqual(events, ["callback", "finish", "close"]);
assert.equal(response.socket, undefined);
assert.equal(response.writeHead(204), response);
console.log("http2 body, trailers and finish/close lifecycle");

const malformed = new Http2ServerResponse(new ResponseStream());
assert.throws(() => malformed.writeHead(200, ["odd"]), { code: "ERR_INVALID_ARG_VALUE" });
assert.throws(() => malformed.createPushResponse({}, null), { code: "ERR_INVALID_ARG_TYPE" });
malformed.destroy();
const tuples = new ResponseStream();
const tupleResponse = new Http2ServerResponse(tuples);
tupleResponse.setHeader("x-test", "old");
tupleResponse.writeHead(202, [["x-test", "a"], ["x-test", "b"]]);
assert.deepEqual(tupleResponse.getHeader("x-test"), ["a", "b"]);
const pushed = await new Promise<Http2ServerResponse>((resolve, reject) => {
  tupleResponse.createPushResponse({ ":path": "/asset" }, (error, value) => error ? reject(error) : resolve(value));
});
assert.ok(pushed instanceof Http2ServerResponse);
pushed.end();
tupleResponse.destroy();
class Derived extends Http2ServerResponse {}
const derived = new Derived(new ResponseStream());
assert.ok(derived instanceof Http2ServerResponse);
derived.end();
console.log("http2 duplicate tuples, push response and subclasses");

class ClosingStream extends ResponseStream {
  _final(_callback: () => void) { this.destroy(); }
}
type EndOverload = "callback" | "chunk-callback" | "chunk-encoding-callback";
async function verifyEnd(StreamClass: typeof ResponseStream, overload: EndOverload) {
  const stream = new StreamClass();
  const response = new Http2ServerResponse(stream);
  const events: string[] = [];
  let callbacks = 0;
  stream.on("finish", () => { events.push("stream-finish"); });
  response.on("finish", () => { events.push("response-finish"); });
  const closed = new Promise<void>(resolve => response.once("close", () => { events.push("close"); resolve(); }));
  const done = function (this: unknown, ...args: unknown[]) {
    callbacks++;
    assert.equal(this, undefined);
    assert.deepEqual(args, []);
    assert.equal(stream.listenerCount("finish"), 1);
    assert.equal(response.listenerCount("finish"), 1);
    events.push("callback");
  };
  if (overload === "callback") assert.equal(response.end(done), response);
  if (overload === "chunk-callback") assert.equal(response.end("body", done), response);
  if (overload === "chunk-encoding-callback") assert.equal(response.end("body", "utf8", done), response);
  await closed;
  assert.equal(callbacks, 1);
  assert.deepEqual(stream.chunks, overload === "callback" ? [] : ["body"]);
  assert.deepEqual(events, StreamClass === ClosingStream
    ? ["response-finish", "callback", "close"]
    : ["stream-finish", "callback", "response-finish", "close"]);
  stream.emit("finish");
  response.emit("finish");
  assert.equal(callbacks, 1);
  assert.equal(stream.listenerCount("finish"), 1);
  assert.equal(response.listenerCount("finish"), 1);
  stream.removeAllListeners("finish");
  response.removeAllListeners("finish");
}
for (const StreamClass of [ClosingStream, ResponseStream]) {
  for (const overload of ["callback", "chunk-callback", "chunk-encoding-callback"] satisfies EndOverload[]) {
    await verifyEnd(StreamClass, overload);
  }
}
console.log("http2 end overloads complete once and remove paired finish listeners");

const repeatStream = new ClosingStream();
const repeatResponse = new Http2ServerResponse(repeatStream);
const repeatClosed = new Promise<void>(resolve => repeatResponse.once("close", resolve));
let repeatCallbacks = 0;
repeatResponse.end(() => { repeatCallbacks++; });
const repeatEnded = new Promise<void>(resolve => repeatResponse.end(() => { repeatCallbacks++; resolve(); }));
await Promise.all([repeatClosed, repeatEnded]);
await new Promise<void>(resolve => repeatResponse.end(() => { repeatCallbacks++; resolve(); }));
assert.equal(repeatCallbacks, 3);
assert.equal(repeatStream.listenerCount("finish"), 0);
assert.equal(repeatResponse.listenerCount("finish"), 0);

const endedStream = new ResponseStream({ autoDestroy: false });
const ended = new Promise<void>(resolve => endedStream.once("finish", resolve));
endedStream.end();
await ended;
const endedResponse = new Http2ServerResponse(endedStream);
const endedClosed = new Promise<void>(resolve => endedResponse.once("close", resolve));
let endedCallbacks = 0;
endedResponse.end(function (this: unknown) {
  endedCallbacks++;
  assert.equal(this, endedResponse);
  assert.equal(endedStream.listenerCount("finish"), 0);
  assert.equal(endedResponse.listenerCount("finish"), 0);
});
endedStream.destroy();
await endedClosed;
assert.equal(endedCallbacks, 1);
console.log("http2 repeated end and already-ended stream lifecycle");

const failure = new Error("http2 controlled stream failure");
class FailingStream extends ResponseStream {
  _final(_callback: () => void) { this.destroy(failure); }
}
const failingStream = new FailingStream();
const failingResponse = new Http2ServerResponse(failingStream);
const failureEvents: string[] = [];
failingStream.on("error", error => { assert.equal(error, failure); failureEvents.push("stream-error"); });
failingResponse.on("error", () => { assert.fail("stream errors must not be replaced or forwarded"); });
failingResponse.on("finish", () => { failureEvents.push("response-finish"); });
const failedClosed = new Promise<void>(resolve => failingResponse.once("close", resolve));
failingResponse.end("body", "utf8", (...args: unknown[]) => {
  assert.deepEqual(args, []);
  assert.equal(failingStream.listenerCount("finish"), 0);
  assert.equal(failingResponse.listenerCount("finish"), 1);
  failureEvents.push("callback");
});
await failedClosed;
assert.deepEqual(failureEvents, ["stream-error", "response-finish", "callback"]);
class ThrowingStream extends ResponseStream {
  _write(_chunk: Uint8Array, _encoding: string, _callback: () => void) { throw failure; }
}
const throwingStream = new ThrowingStream();
const throwingResponse = new Http2ServerResponse(throwingStream);
assert.throws(() => throwingResponse.end("body", () => { assert.fail("write threw before end"); }), error => error === failure);
assert.equal(throwingStream.listenerCount("finish"), 0);
assert.equal(throwingResponse.listenerCount("finish"), 0);
throwingResponse.destroy();
console.log("http2 end preserves stream error identity");
