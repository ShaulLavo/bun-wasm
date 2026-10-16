function assert(value, message = "assertion") { if (!value) throw new Error(message); }
function check(label, test) {
  const saved = Error.prepareStackTrace;
  let failure;
  try { test(); } catch (error) { failure = error; }
  finally { Error.prepareStackTrace = saved; }
  console.log(label, failure ? "FAIL " + String(failure) : "ok");
}

for (const mode of ["self", "new Error", "nested capture"]) {
  check(mode + " reentrant", () => {
    let calls = 0, nested, fallback;
    const result = {};
    Error.prepareStackTrace = error => {
      assert(++calls < 5, "recursive formatter");
      if (mode === "self") fallback = error.stack;
      else {
        nested = mode === "new Error" ? new Error("nested") : {};
        if (mode === "nested capture") Error.captureStackTrace(nested);
        fallback = nested.stack;
      }
      assert(typeof fallback === "string");
      return result;
    };
    const target = {};
    Error.captureStackTrace(target);
    assert(target.stack === result && target.stack === result && calls === 1);
    if (nested) assert(nested.stack === fallback && calls === 1);
    const fresh = {};
    Error.captureStackTrace(fresh);
    assert(fresh.stack === result && calls === 2);
  });
}
check("throw clears guard", () => {
  let calls = 0;
  const token = {}, result = {};
  Error.prepareStackTrace = () => { calls++; throw token; };
  const target = {};
  Error.captureStackTrace(target);
  let caught;
  try { target.stack; } catch (error) { caught = error; }
  assert(caught === token && calls === 1);
  Error.prepareStackTrace = () => { calls++; return result; };
  assert(target.stack === result && target.stack === result && calls === 2);
});
check("self read survives formatter throw", () => {
  let calls = 0, fallback;
  const token = {};
  Error.prepareStackTrace = error => {
    assert(++calls < 5, "recursive formatter");
    fallback = error.stack;
    throw token;
  };
  const target = {};
  Error.captureStackTrace(target);
  let caught;
  try { target.stack; } catch (error) { caught = error; }
  assert(caught === token && calls === 1 && typeof fallback === "string");
  Error.prepareStackTrace = () => { calls++; return "fresh"; };
  assert(target.stack === fallback && calls === 1);
  const fresh = {};
  Error.captureStackTrace(fresh);
  assert(fresh.stack === "fresh" && calls === 2);
});
check("nested read survives formatter throw", () => {
  let calls = 0, nested, fallback;
  const token = {};
  Error.prepareStackTrace = () => {
    assert(++calls < 5, "recursive formatter");
    nested = {};
    Error.captureStackTrace(nested);
    fallback = nested.stack;
    throw token;
  };
  const target = {};
  Error.captureStackTrace(target);
  let caught;
  try { target.stack; } catch (error) { caught = error; }
  assert(caught === token && calls === 1 && typeof fallback === "string");
  Error.prepareStackTrace = () => { calls++; return "fresh"; };
  assert(nested.stack === fallback && calls === 1);
  assert(target.stack === "fresh" && calls === 2);
});

for (const lock of [Object.freeze, Object.seal]) {
  check("self read then " + lock.name, () => {
    let calls = 0;
    const result = {};
    Error.prepareStackTrace = error => {
      assert(++calls < 5, "recursive formatter");
      assert(typeof error.stack === "string");
      lock(error);
      return result;
    };
    const target = {};
    Error.captureStackTrace(target);
    assert(target.stack === result && target.stack === result && calls === 1);
  });
}
