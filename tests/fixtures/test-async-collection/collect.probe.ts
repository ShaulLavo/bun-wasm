import assert from "node:assert/strict";
import { beforeAll, describe, test } from "bun:test";
import { delay, note } from "./note.ts";

const scenario = process.env.CASE;
if (scenario === "order") {
  note("before");
  const value = describe("A", async () => {
    note("A enter"); await delay(); note("A resume");
    describe("nested", async () => {
      note("nested enter"); await delay(); note("nested resume");
      test("nested", () => note("nested body"));
    });
    note("after nested call");
    test("A", () => note("A body"));
  });
  assert.equal(value, undefined);
  note("after");
  await delay(); note("root TLA");
  describe("B", async () => { note("B enter"); await Promise.resolve(); test("B", () => note("B body")); });
}
if (scenario === "duplicate") {
  const callback = async () => { note("duplicate collect"); await delay(); test("duplicate", () => note("duplicate body")); };
  describe("first", callback); describe("second", callback);
}
if (scenario === "disabled") {
  describe.skip("skip", async () => {
    note("skip enter"); await delay(); note("skip resume");
    beforeAll(() => note("must not run")); test("disabled", () => note("must not run"));
  });
  describe.todo("todo", async () => {
    note("todo enter"); await delay(); note("todo resume");
    beforeAll(() => note("must not run")); test("disabled", () => note("must not run"));
  });
  describe.skip("no callback"); describe.todo("no callback");
}
if (["reject", "test-only", "describe-only", "nested-only", "good-only"].includes(scenario || "")) {
  const callback = async () => {
    note("bad enter");
    beforeAll(() => note("must not run"));
    const register = scenario === "test-only" ? test.only : test;
    register("excluded", () => note("must not run"));
    const nested = scenario === "nested-only" ? describe.only : describe;
    nested("excluded nested", () => note("must not collect"));
    await delay(); note("bad reject"); throw Error("owned collection rejection");
  };
  const register = scenario === "describe-only" ? describe.only : describe;
  register("failed", callback);
  const good = scenario === "good-only" ? describe.only : describe;
  good("good", () => { note("good enter"); test("good", () => note("good body")); });
}
if (scenario === "cache") {
  describe("first failed owner", async () => { await import("./declarations.ts"); throw Error("owned collection rejection"); });
  describe("second owner", async () => { await import("./declarations.ts"); test("second", () => note("second body")); });
}
let reads = 0;
if (scenario === "intrinsic") {
  describe("intrinsic", () => {
    const error = Object.defineProperty(Error("owned collection rejection"), "then", { get() { reads++; throw Error("reason then read"); } });
    const completion = Promise.reject(error);
    Object.defineProperty(completion, "then", { get() { reads++; throw Error("public then read"); } });
    return completion;
  });
}
if (scenario === "preload") {
  note("root after import");
  describe("queued", async () => { note("queued enter"); await delay(); note("queued resume"); test("owned", () => note("owned body")); });
}
if (scenario === "root-reject") {
  describe("never collected", () => note("must not collect"));
  await delay(); note("root reject"); throw Error("root import rejection");
}
test("sentinel", () => { assert.equal(reads, 0); note("sentinel"); });
