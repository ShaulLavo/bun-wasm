import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { observeNativeClick } from "./native-click";

const input = { button: "button", clicked: "output", token: "private-input-token" };
const observation = `(${observeNativeClick.toString()})(${JSON.stringify(input)})`;
const cases = [
  { field: "state", detail: "state-missing; statePresent=false", reads: ["state"] },
  { field: "token", detail: "token-mismatch; statePresent=true; tokenEqual=false", reads: ["state", "token"] },
  { field: "url", detail: "url-mismatch; statePresent=true; tokenEqual=true; urlEqual=false", reads: ["state", "token", "url", "href"] },
  { field: "timeOrigin", detail: "time-origin-mismatch; statePresent=true; tokenEqual=true; urlEqual=true; timeOriginEqual=false", reads: ["state", "token", "url", "href", "timeOrigin", "currentTimeOrigin"] },
];

function fixture(failed: string) {
  const reads: string[] = [];
  const read = (field: string, value: unknown) => { reads.push(field); return value; };
  const state = {
    get token() { return read("token", failed === "token" ? "private-other-token" : input.token); },
    get url() { return read("url", failed === "url" ? "https://private.test/other" : "https://private.test/current"); },
    get timeOrigin() { return read("timeOrigin", failed === "timeOrigin" ? 321 : 123); },
    get target() { throw new Error("Target must not be read after a document failure"); },
  };
  const context = createContext({
    get __goalsNativeClick() { return read("state", failed === "state" ? undefined : state); },
    location: { get href() { return read("href", "https://private.test/current"); } },
    performance: { get timeOrigin() { return read("currentTimeOrigin", 123); } },
  });
  return { context, reads };
}

test.each(cases)("generated observer reports $field failure with only evaluated boolean evidence", row => {
  const { context, reads } = fixture(row.field);
  expect(runInContext(`try { ${observation} } catch (error) { error.message }`, context)).toBe(`Native click document changed: ${row.detail}`);
  expect(reads).toEqual(row.reads);
});

test.each([undefined, null, false, 0, ""])("the missing-state guard retains its original falsy behavior: %p", state => {
  const context = createContext({ __goalsNativeClick: state });
  expect(runInContext(`try { ${observation} } catch (error) { error.message }`, context)).toBe("Native click document changed: state-missing; statePresent=false");
});
