import assert from "node:assert/strict";

for (const reason of [undefined, null, false, 0, ""]) {
  let observed = false;
  let promise: Promise<never>;
  const handler = (error: unknown, original: unknown) => {
    assert.equal(error, reason);
    assert.equal(original, promise);
    observed = true;
  };
  process.on("unhandledRejection", handler);
  try {
    promise = Promise.reject(reason);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(observed, true);
  } finally {
    process.removeListener("unhandledRejection", handler);
  }
}
console.log("native rejection promise identity");
