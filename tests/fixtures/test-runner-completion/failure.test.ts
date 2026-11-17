import { test } from "bun:test";

test.failing("a promise timeout remains a failure", () => new Promise(() => {}), 10);
test.failing("a missing done remains a failure", _done => {}, 10);
test.failing("a fulfilled callback body did not fail", async _done => {}, 10);
test("synchronous error after done", done => {
  done();
  throw new Error("synchronous post-done error");
});
test("returned rejection after done", async done => {
  await Promise.resolve();
  done();
  throw new Error("asynchronous post-done error");
});
test("exception in the callback that calls done", done => {
  setTimeout(() => { done(); throw new Error("timer post-done error"); }, 0);
});
test("done cannot hide a pending returned promise", done => {
  done();
  return new Promise(() => {});
}, 10);
test("done error does not wait for a pending returned promise", done => {
  done(new Error("done error before pending promise"));
  return new Promise(() => {});
}, 10);
test("following test retains its own invocation", () => {});
