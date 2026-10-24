import { expect, test } from "bun:test";
import { MessageListenerProbe } from "../../tests/shell-consumer/message-listener-probe";

test("preview listener probe measures actual registration without invoking the preview router", () => {
  const target = new EventTarget();
  let delivered = 0;
  const probe = new MessageListenerProbe(target, () => { delivered++; });
  expect(probe.count()).toBe(0);
  target.addEventListener("message", probe.listener);
  try {
    expect(probe.count()).toBe(1);
    expect(delivered).toBe(0);
    target.dispatchEvent(new MessageEvent("message"));
    expect(delivered).toBe(1);
  } finally { target.removeEventListener("message", probe.listener); }
  expect(probe.assertRemoved()).toBe(0);
});

test("negative control: removing a different callback fails the same listener teardown check", () => {
  const target = new EventTarget();
  let delivered = 0;
  const probe = new MessageListenerProbe(target, () => { delivered++; });
  target.addEventListener("message", probe.listener);
  try {
    target.removeEventListener("message", () => {});
    expect(probe.count()).toBe(1);
    expect(() => probe.assertRemoved()).toThrow("zero owned page listeners, got 1");
    target.dispatchEvent(new MessageEvent("message"));
    expect(delivered).toBe(1);
  } finally { target.removeEventListener("message", probe.listener); }
  expect(probe.assertRemoved()).toBe(0);
});
