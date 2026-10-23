// assert.CallTracker (deprecated, DEP0173) as Node and Bun ship it.
import assert from "node:assert";

const tracker = new assert.CallTracker();
function add(a: number, b: number) {
  return a + b;
}
const tracked = tracker.calls(add, 2);
console.log("result", tracked(1, 2));
console.log("calls", JSON.stringify(tracker.getCalls(tracked)));
console.log("frozen", Object.isFrozen(tracker.getCalls(tracked)), Object.isFrozen(tracker.getCalls(tracked)[0].arguments));
console.log("report", JSON.stringify(tracker.report().map(({ message, actual, expected, operator }) => ({ message, actual, expected, operator }))));
try {
  tracker.verify();
} catch (error) {
  const { name, code, message } = error as { name: string; code: string; message: string };
  console.log("verify", name, code, message, (error as Record<string, unknown>)["actual 0"]);
}
tracked(3, 4);
tracker.verify();
console.log("verified");
tracker.reset(tracked);
console.log("after reset", tracker.getCalls(tracked).length);
const noop = tracker.calls(1);
noop();
console.log("noop", tracker.getCalls(noop).length);
for (const bad of [() => tracker.getCalls(add), () => tracker.calls(add, 0), () => tracker.calls(add, 1.5), () => tracker.calls(add, "2" as never)]) {
  try {
    bad();
  } catch (error) {
    const { name, code, message } = error as { name: string; code: string; message: string };
    console.log(name, code, message);
  }
}
const second = tracker.calls(() => {}, 1);
const third = tracker.calls(() => {}, 1);
try {
  tracker.verify();
} catch (error) {
  console.log("multiple", (error as Error).message, Object.keys(error as object).filter(key => key.startsWith("message ")).length);
}
second();
third();
