function check(ok, label) {
  if (!ok) throw new Error(label);
}

function caught(run) {
  try { run(); } catch (error) { return error; }
  return undefined;
}

function resource(error, log, name) {
  return { [Symbol.dispose]() { log.push(name); if (error !== undefined) throw error; } };
}

function checkChain(error, expected) {
  for (const original of expected.slice(0, -1)) {
    check(error instanceof SuppressedError, "SuppressedError brand");
    check(error.error === original, "disposer error identity and order");
    error = error.suppressed;
  }
  check(error === expected.at(-1), "original suppressed identity");
}

const body = { origin: "body" };
const first = { origin: "first disposer" };
const second = { origin: "second disposer" };
const log = [];

// The minimal failing control has no conditional in the using body or disposer.
const minimal = caught(() => {
  using held = { [Symbol.dispose]() { throw first; } };
  throw body;
});
checkChain(minimal, [first, body]);

for (const throwsBody of [false, true]) {
  for (const throwsDisposer of [false, true]) {
    log.length = 0;
    const observed = caught(() => {
      using held = resource(throwsDisposer ? first : undefined, log, "held");
      if (throwsBody) throw body;
    });
    const expected = [];
    if (throwsDisposer) expected.push(first);
    if (throwsBody) expected.push(body);
    checkChain(observed, expected.length ? expected : [undefined]);
    check(log.join() === "held", "single disposal");
  }
}

function nested(throwsBody) {
  using outer = resource(first, log, "outer");
  {
    using inner = resource(second, log, "inner");
    using quiet = resource(undefined, log, "quiet");
    if (throwsBody) throw body;
  }
}

for (const throwsBody of [false, true]) {
  log.length = 0;
  const observed = caught(() => nested(throwsBody));
  checkChain(observed, throwsBody ? [first, second, body] : [first, second]);
  check(log.join() === "quiet,inner,outer", "nested reverse disposal order");
}

const primitive = caught(() => {
  using held = { [Symbol.dispose]() { throw null; } };
  throw 17;
});
checkChain(primitive, [null, 17]);

const getterError = { origin: "dispose getter" };
check(caught(() => {
  using held = { get [Symbol.dispose]() { throw getterError; } };
}) === getterError, "dispose getter error identity");

console.log("suppressed error controls passed");
