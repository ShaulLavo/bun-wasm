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
