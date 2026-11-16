import { afterAll, describe, onTestFinished, test } from "bun:test";
import { gate, completed, rejected, events } from "./late-state.ts";

function attempt(label: string, register: () => void) {
  try { register(); } catch (error) {
    if (!String(error).includes("collection")) throw error;
    rejected.push(label);
  }
}
describe("origin", () => {
  void (async () => {
    await gate.promise;
    attempt("test", () => test.only("stale", () => {}));
    attempt("describe", () => describe.only("stale", () => {}));
    attempt("afterAll", () => afterAll(() => events.push("stale")));
    attempt("finished", () => onTestFinished(() => events.push("stale")));
    completed.resolve();
  })();
});
