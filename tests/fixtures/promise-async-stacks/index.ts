import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";

const context = new AsyncLocalStorage<string>();
const observations: { label: string; stack: string }[] = [];

function observe(label: string, error: Error, firstFrame: string): Error {
  const stack = error.stack;
  assert.equal(typeof stack, "string", `${label}: stack text`);
  assert.equal(error.message, label, `${label}: message`);
  assert(stack.includes(firstFrame), `${label}: allocation frame`);
  assert(stack.includes("index.ts:"), `${label}: source mapping`);
  assert.equal(error.stack, stack, `${label}: memoized stack`);
  if (firstFrame === "allocationLeaf" && ["interp", "pbl"].includes(process.env.BUN_WASM_SPIDERMONKEY_TIER ?? "")) {
    assert(stack.indexOf("allocationLeaf") < stack.indexOf("allocationParent"), `${label}: parent order`);
    assert(stack.indexOf("allocationParent") < stack.indexOf("allocationRoot"), `${label}: root order`);
  }
  observations.push({ label, stack });
  return error;
}

async function allocationLeaf(label: string): Promise<Error> {
  await null;
  assert.equal(context.getStore(), "request");
  return observe(label, new Error(label), "allocationLeaf");
}
async function allocationParent(label: string): Promise<Error> {
  return await allocationLeaf(label);
}
async function allocationRoot(label: string): Promise<Error> {
  return await allocationParent(label);
}

function reactionPath(): Promise<Error> {
  return Promise.resolve().then(function firstReaction() {
    return Promise.resolve().then(function secondReaction() {
      assert.equal(context.getStore(), "request");
      return observe("then", new Error("then"), "secondReaction");
    });
  });
}

async function* generatorPath(): AsyncGenerator<Error> {
  await null;
  assert.equal(context.getStore(), "request");
  yield observe("generator", new Error("generator"), "generatorPath");
}

async function capturedRejection(): Promise<void> {
  const reason = observe("captured rejection", new Error("captured rejection"), "capturedRejection");
  const stack = reason.stack;
  const promise = Promise.reject(reason);
  await promise.then(() => assert.fail("rejection resolved"), caught => {
    assert.equal(caught, reason);
    assert.equal(caught.stack, stack);
    assert.equal(context.getStore(), "request");
  });
}

function lazyDescriptor(): void {
  const previous = Error.prepareStackTrace;
  let calls = 0;
  const token = {};
  Error.prepareStackTrace = () => { calls++; return token; };
  try {
    const target = {};
    Error.captureStackTrace(target);
    const before = Object.getOwnPropertyDescriptor(target, "stack");
    assert(before?.configurable);
    assert.equal(before.enumerable, false);
    assert.equal(calls, 0);
    assert.equal(Reflect.get(target, "stack"), token);
    assert.equal(Reflect.get(target, "stack"), token);
    assert.equal(calls, 1);
    assert.equal(Reflect.set(target, "stack", "assigned"), true);
    assert.equal(Reflect.get(target, "stack"), "assigned");
  } finally { Error.prepareStackTrace = previous; }
}

async function lateHandled(reason: unknown): Promise<void> {
  let original: Promise<never> | undefined;
  let unhandled = false;
  let handled = false;
  const onUnhandled = (observed: unknown, promise: Promise<never>) => {
    assert.equal(observed, reason);
    assert.equal(promise, original);
    unhandled = true;
    void promise.catch(caught => {
      assert.equal(caught, reason);
      handled = true;
    });
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    original = Promise.reject(reason);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert(unhandled, "unhandled rejection identity observed");
    assert(handled, "late handler identity observed");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

await context.run("request", async () => {
  await allocationRoot("await");
  await reactionPath();
  for await (const error of generatorPath()) assert(error instanceof Error);
  const combined = await Promise.all([allocationRoot("all one"), allocationRoot("all two")]);
  assert.equal(combined.length, 2);
  assert.equal(await Promise.race([Promise.resolve(combined[0])]), combined[0]);
  const settled = await Promise.allSettled([Promise.resolve(combined[0]), Promise.reject(combined[1])]);
  assert.deepEqual(settled, [{ status: "fulfilled", value: combined[0] }, { status: "rejected", reason: combined[1] }]);
  await capturedRejection();
  lazyDescriptor();
  for (const reason of [undefined, null, false, 0, "", "primitive", { token: "identity" }, new Error("late")]) await lateHandled(reason);
  assert.equal(context.getStore(), "request");
});
assert.equal(context.getStore(), undefined);
assert.equal(observations.length, 6);
if (process.env.BUN_WASM_ASYNC_STACK_OBSERVATIONS) writeFileSync("observations.json", JSON.stringify(observations, null, 2) + "\n");
console.log("async allocation stacks, reactions, generators and combinators ok");
console.log("captured and primitive rejection identities and late handlers ok");
console.log("lazy stack descriptors and async local storage ok");
