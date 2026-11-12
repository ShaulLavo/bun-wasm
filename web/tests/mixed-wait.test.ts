import { expect, test } from "bun:test";
import type { NotificationWaitSet } from "waffle/browser/notification-wait";
import { waitForIo, type MixedWaitSources } from "../src/net/mixed-wait";

function fixture() {
  const events: string[] = [];
  let clock = 0;
  const set: NotificationWaitSet = {
    covered: true, disposed: false,
    sample() { events.push("sample"); return { sequence: 0, filesystem: 0, network: 0, process: 0 }; },
    wait(_sample, deadline) { events.push("wait"); expect(deadline).toBeGreaterThan(clock); clock++; return "not-equal"; },
    setProcessSubscriptions() {}, dispose() {},
  };
  const sources: MixedWaitSources = {
    set, checkActive() { events.push("active"); },
    networkReady() { events.push("network"); return 0; },
    processReady() { events.push("process"); return 0; },
  };
  return { sources, events, now: () => clock };
}

test("every not-equal wake still reaches the original finite deadline", () => {
  const f = fixture();
  expect(waitForIo(f.sources, 3, f.now)).toBe(0);
  expect(f.events.filter(value => value === "wait")).toHaveLength(3);
  expect(f.events.slice(0, 5)).toEqual(["active", "sample", "network", "active", "process"]);
});

test("zero timeout scans once; network readiness consumes news only once", () => {
  const f = fixture();
  expect(waitForIo(f.sources, 0, f.now)).toBe(0);
  expect(f.events.filter(value => value === "wait")).toHaveLength(0);
  f.events.length = 0;
  f.sources.networkReady = () => { f.events.push("network"); return 1; };
  expect(waitForIo(f.sources, 0, f.now)).toBe(1);
  expect(f.events).toEqual(["active", "sample", "network", "active"]);
});

test("negative timeout is infinite; scope closure and fatal cancellation end parking", () => {
  const f = fixture();
  f.sources.set.wait = (_sample, deadline) => { expect(deadline).toBe(Infinity); return "closed"; };
  expect(waitForIo(f.sources, -20, f.now)).toBe(0);
  let canceled = false;
  f.sources.set.wait = () => { canceled = true; return "ok"; };
  f.sources.checkActive = () => { if (canceled) throw new Error("fatal cancellation"); };
  expect(() => waitForIo(f.sources, 50, f.now)).toThrow("fatal cancellation");
});

test("process scan errors propagate and readiness needs no extra scan", () => {
  const f = fixture();
  f.sources.processReady = () => -8;
  expect(waitForIo(f.sources, 50, f.now)).toBe(-8);
  f.sources.processReady = () => 2;
  expect(waitForIo(f.sources, 50, f.now)).toBe(1);
});
