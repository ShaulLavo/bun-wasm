function check(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: ${actual} !== ${expected}`);
}

/** Shared native/guest and actual-factory outcomes, with no timing assumptions. */
export function portRefChecks() {
  const pairs: MessageChannel[] = [];
  const port = () => { const pair = new MessageChannel(); pairs.push(pair); return pair.port2; };
  const listener = () => {};
  try {
    const base = port();
    check(base.hasRef(), false, "initial");
    EventTarget.prototype.addEventListener.call(base, "message", listener);
    check(base.hasRef(), true, "base add");
    EventTarget.prototype.removeEventListener.call(base, "message", listener);
    check(base.hasRef(), false, "base remove");
    console.log("port base listener membership");

    const once = port();
    let inside: boolean | undefined;
    once.addEventListener("message", () => { inside = once.hasRef(); }, { once: true });
    check(once.hasRef(), true, "once add");
    once.dispatchEvent(new MessageEvent("message", { data: 1 }));
    check(inside, false, "once inside");
    check(once.hasRef(), false, "once after");
    const signal = port(), controller = new AbortController();
    signal.addEventListener("message", listener, { signal: controller.signal });
    check(signal.hasRef(), true, "signal add");
    signal.removeEventListener = () => { throw new Error("public remover used"); };
    controller.abort();
    check(signal.hasRef(), false, "signal removed");
    signal.addEventListener("message", listener, { signal: AbortSignal.abort() });
    check(signal.hasRef(), false, "preaborted");
    console.log("port once and signal release refs");

    const duplicate = port();
    duplicate.addEventListener("message", listener);
    duplicate.addEventListener("message", listener);
    duplicate.addEventListener("message", listener, true);
    duplicate.removeEventListener("message", listener);
    check(duplicate.hasRef(), true, "capture remains");
    duplicate.removeEventListener("message", listener, true);
    check(duplicate.hasRef(), false, "last capture removed");
    console.log("port duplicate capture demand");

    const sticky = port();
    sticky.unref();
    sticky.addEventListener("message", listener);
    sticky.addEventListener("message", listener);
    check(sticky.hasRef(), false, "unref then web add");
    sticky.on("message", listener);
    check(sticky.hasRef(), false, "unref then node add");
    sticky.ref();
    sticky.removeEventListener("message", listener);
    sticky.removeAllListeners("message");
    check(sticky.hasRef(), true, "ref then last removal");
    sticky.addEventListener("message", listener, { signal: AbortSignal.abort() });
    check(sticky.hasRef(), true, "ref then preaborted");
    sticky.removeEventListener("message", listener);
    check(sticky.hasRef(), true, "ref then missing removal");
    console.log("port explicit ref choices stay sticky");

    const attribute = port();
    attribute.unref();
    attribute.onmessage = listener;
    check(attribute.hasRef(), true, "onmessage ref choice");
    attribute.addEventListener("message", listener);
    attribute.on("message", listener);
    attribute.onmessage = null;
    check(attribute.hasRef(), false, "onmessage clear with other demand");
    attribute.addEventListener("message", () => {});
    check(attribute.hasRef(), false, "clear then ordinary add");
    attribute.onmessage = listener;
    attribute.unref();
    attribute.onmessage = listener;
    check(attribute.hasRef(), true, "same attribute selects ref");
    attribute.ref();
    attribute.onmessage = null;
    check(attribute.hasRef(), false, "clear selects unref");
    console.log("port onmessage selects explicit ref mode");

    const mixed = port(), other = () => {};
    mixed.on("message", listener);
    mixed.addEventListener("message", other, { once: true });
    mixed.dispatchEvent(new MessageEvent("message", { data: 2 }));
    check(mixed.hasRef(), true, "node demand remains");
    mixed.removeListener("message", listener);
    check(mixed.hasRef(), false, "mixed last removal");
    let called = 0;
    const reentrant = port();
    const added = () => { called++; };
    reentrant.addEventListener("message", () => { reentrant.addEventListener("message", added); }, { once: true });
    reentrant.dispatchEvent(new MessageEvent("message"));
    check(called, 0, "reentrant add is later delivery");
    check(reentrant.hasRef(), true, "reentrant demand remains");
    reentrant.removeEventListener("message", added);
    check(reentrant.hasRef(), false, "reentrant removal");
    console.log("port mixed and reentrant demand");
  } finally {
    for (const pair of pairs) { pair.port1.close(); pair.port2.close(); }
  }
}
import { MessageChannel } from "node:worker_threads";

