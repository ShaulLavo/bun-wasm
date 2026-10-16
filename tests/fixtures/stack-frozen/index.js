function assert(value, message = "assertion") { if (!value) throw new Error(message); }
function check(label, test) {
  const saved = Error.prepareStackTrace;
  let failure;
  try { test(); } catch (error) { failure = error; }
  finally { Error.prepareStackTrace = saved; }
  console.log(label, failure ? "FAIL " + String(failure) : "ok");
}

for (const [name, lock] of [["frozen", Object.freeze], ["sealed", Object.seal], ["nonextensible", Object.preventExtensions]]) {
  check(name + " Error", () => {
    let calls = 0;
    Error.prepareStackTrace = () => { calls++; return "formatted"; };
    const error = lock(new Error("locked"));
    const first = error.stack;
    assert(typeof first === "string");
    Error.prepareStackTrace = () => { calls++; return "changed"; };
    assert(error.stack === first && calls <= 1);
  });
  check(name + " capture", () => {
    let calls = 0;
    const result = {};
    Error.prepareStackTrace = () => { calls++; return result; };
    const target = {};
    Error.captureStackTrace(target);
    lock(target);
    assert(calls === 0);
    assert(target.stack === result && target.stack === result && calls === 1);
    target.stack = "assigned";
    assert(target.stack === "assigned" && calls === 1);
  });
  for (const preset of [false, true]) {
    check(name + (preset ? " existing" : " empty") + " capture rejects", () => {
      let calls = 0;
      Error.prepareStackTrace = () => { calls++; return "unexpected"; };
      const target = lock(preset ? {stack: "original"} : {});
      let caught;
      try { Error.captureStackTrace(target); } catch (error) { caught = error; }
      assert(caught instanceof TypeError && calls === 0);
      assert(target.stack === (preset ? "original" : undefined));
    });
  }
}
check("nonconfigurable capture rejects", () => {
  let calls = 0;
  Error.prepareStackTrace = () => { calls++; return "unexpected"; };
  const target = {};
  Object.defineProperty(target, "stack", {value: "original", writable: true});
  let caught;
  try { Error.captureStackTrace(target); } catch (error) { caught = error; }
  assert(caught instanceof TypeError && calls === 0 && target.stack === "original");
});
check("recapture replaces memo", () => {
  const target = {};
  const first = {}, second = {};
  Error.prepareStackTrace = () => first;
  Error.captureStackTrace(target);
  assert(target.stack === first);
  Error.prepareStackTrace = () => second;
  Error.captureStackTrace(target);
  assert(target.stack === second && target.stack === second);
});
