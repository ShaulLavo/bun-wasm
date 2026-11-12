import { expect, test } from "bun:test";
import { forwardQuotaRequest, type QuotaControl } from "./persistence-quota";

function replyFor(idleQuota: "cap" | "reset", control: QuotaControl) {
  return new Promise(resolve => {
    expect(forwardQuotaRequest({ idleQuota }, control, resolve)).toBe(true);
  });
}

test("unnumbered provider quota messages reply for cap and reset", async () => {
  const actions: string[] = [];
  const control: QuotaControl = async action => { actions.push(action); return true; };
  expect(await replyFor("cap", control)).toEqual({ kind: "idle-quota-result", active: true });
  expect(await replyFor("reset", control)).toEqual({ kind: "idle-quota-result", active: true });
  expect(actions).toEqual(["cap", "reset"]);
});

test("quota host errors reach the provider, including synchronous failures", async () => {
  expect(await replyFor("cap", async () => { throw new Error("CDP failed"); }))
    .toEqual({ kind: "idle-quota-result", error: "Error: CDP failed" });
  expect(await replyFor("reset", () => { throw new Error("reset failed"); }))
    .toEqual({ kind: "idle-quota-result", error: "Error: reset failed" });
});

test("unsupported hosts reply truthfully and command replies are not consumed", async () => {
  expect(await replyFor("cap", async () => false)).toEqual({ kind: "idle-quota-result", active: false });
  for (const data of [null, { id: 1, value: [] }, { idleQuota: "other" }]) {
    expect(forwardQuotaRequest(data, async () => { throw new Error("unexpected control"); }, () => {
      throw new Error("unexpected reply");
    })).toBe(false);
  }
});
