import assert from "node:assert/strict";
import { htmlRewriterCount } from "bun:internal-for-testing";
import { cancellationContracts } from "./cancellation";

const baseline = htmlRewriterCount();
const intrinsicThen = Promise.prototype.then;
const html = "<p>x</p>";
function rewrite(value: unknown) {
  const rewriter = new HTMLRewriter();
  // Public Bun types exclude the deliberately probed custom return values.
  Reflect.apply(rewriter.on, rewriter, ["p", { element: () => value }]);
  return rewriter.transform(new Response(html)).text();
}

async function contract(name: string, check: () => Promise<void>) {
  console.error(`CASE start ${name}`);
  try {
    await check();
    assert.equal(htmlRewriterCount(), baseline, `${name}: native parser count`);
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`CASE fail ${name}: ${String(error)}; parsers=${htmlRewriterCount()}, baseline=${baseline}`);
    throw error;
  }
}

async function rejectsExactly(value: unknown, expected: unknown) {
  const outcome = await rewrite(value).then(text => ({ kind: "fulfilled", text }), error => ({ kind: "rejected", error }));
  assert.equal(outcome.kind, "rejected");
  assert.ok("error" in outcome);
  assert.equal(outcome.error, expected);
  assert.equal(htmlRewriterCount(), baseline);
}

await contract("native then getter and overridden receiver", async () => {
  const failure = { marker: "then getter" };
  let reads = 0;
  const value = Promise.resolve();
  Object.defineProperty(value, "then", { get() { reads++; throw failure; } });
  await rejectsExactly(value, failure);
  assert.equal(reads, 1);
  const custom = Promise.resolve();
  const receivers: unknown[] = [];
  Object.defineProperty(custom, "then", { value: function (this: unknown) { receivers.push(this); throw failure; } });
  await rejectsExactly(custom, failure);
  assert.deepEqual(receivers, [custom]);
});

await contract("non-callable then never parks", async () => {
  const value = new Promise<void>(() => {});
  let reads = 0;
  Object.defineProperty(value, "then", { get() { reads++; return null; } });
  assert.equal(await rewrite(value), html);
  assert.equal(reads, 1);
});

function proxyValue(intrinsic: boolean) {
  const failure = { marker: "unexpected second prototype query" };
  let prototypes = 0;
  let reads = 0;
  const receivers: unknown[] = [];
  const value = new Proxy({ get then() {
    reads++;
    return intrinsic ? intrinsicThen : function (this: unknown, resolve: () => void) { receivers.push(this); resolve(); };
  } }, { getPrototypeOf() {
    prototypes++;
    if (prototypes > 1) throw failure;
    return null;
  } });
  return { value, failure, receivers, counts: () => ({ prototypes, reads }) };
}

await contract("Proxy custom then keeps one prototype query", async () => {
  const state = proxyValue(false);
  assert.equal(await rewrite(state.value), html);
  assert.deepEqual(state.counts(), { prototypes: 1, reads: 1 });
  assert.deepEqual(state.receivers, [state.value]);
});

await contract("Proxy intrinsic then keeps receiver TypeError", async () => {
  const state = proxyValue(true);
  const result = await rewrite(state.value).then(text => ({ text }), error => ({ error }));
  assert.ok("error" in result);
  assert.ok(result.error instanceof TypeError);
  assert.notEqual(result.error, state.failure);
  assert.deepEqual(state.counts(), { prototypes: 1, reads: 1 });
});

await contract("intrinsic constructor and species order", async () => {
  const order: string[] = [];
  class Species extends Promise<unknown> {
    constructor(executor: ConstructorParameters<typeof Promise>[0]) { order.push("construct"); super(executor); }
  }
  const value = Promise.resolve();
  const constructor = { get [Symbol.species]() { order.push("species"); return Species; } };
  Object.defineProperty(value, "then", { get() { order.push("then"); return intrinsicThen; } });
  Object.defineProperty(value, "constructor", { get() { order.push("constructor"); return constructor; } });
  assert.equal(await rewrite(value), html);
  assert.deepEqual(order, ["then", "constructor", "species", "construct"]);
});

await contract("custom receiver and ignored fulfillment", async () => {
  const value = Promise.resolve();
  let reads = 0;
  const receivers: unknown[] = [];
  const ignored = { get then() { throw new Error("fulfillment was assimilated"); } };
  Object.defineProperty(value, "constructor", { get() { throw new Error("custom receiver constructor was read"); } });
  Object.defineProperty(value, "then", { get() {
    reads++;
    return function (this: unknown, resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      receivers.push(this);
      resolve(ignored);
      reject("ignored second settlement");
      throw new Error("ignored after settlement");
    };
  } });
  assert.equal(await rewrite(value), html);
  assert.equal(reads, 1);
  assert.deepEqual(receivers, [value]);
  const fulfillment = {};
  const native = Promise.resolve(fulfillment);
  Object.defineProperty(fulfillment, "then", { get() { throw new Error("native fulfillment was assimilated again"); } });
  assert.equal(await rewrite(native), html);
});

type FailureSite = "then" | "constructor" | "species getter" | "species constructor" | "native rejection" | "custom rejection" | "custom call";
const failureSites: FailureSite[] = ["then", "constructor", "species getter", "species constructor", "native rejection", "custom rejection", "custom call"];
function failingValue(site: FailureSite, reason: unknown) {
  if (site === "native rejection") return Promise.reject(reason);
  if (site === "custom rejection") return { then(_resolve: () => void, reject: (error: unknown) => void) { reject(reason); } };
  if (site === "custom call") return { then() { throw reason; } };
  const value = Promise.resolve();
  if (site === "then" || site === "constructor") {
    Object.defineProperty(value, site, { get() { throw reason; } });
    return value;
  }
  class Species { constructor() { throw reason; } }
  const constructor = site === "species getter" ? { get [Symbol.species]() { throw reason; } } : { [Symbol.species]: Species };
  Object.defineProperty(value, "constructor", { value: constructor });
  return value;
}

for (const site of failureSites) {
  await contract(`exact errors at ${site}`, async () => {
    for (const reason of [undefined, null, false, 0, "", { marker: site }]) await rejectsExactly(failingValue(site, reason), reason);
  });
}

await cancellationContracts(contract);
