import { addAbortListener, EventEmitter, getEventListeners, listenerCount, once } from "node:events";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function same(actual: unknown, expected: unknown, message: string) {
  check(actual === expected, message);
}

function throwsTypeError(run: () => unknown) {
  try { run(); } catch (error) { check(error instanceof TypeError, "TypeError identity"); return; }
  throw new Error("Expected TypeError");
}

const target = new EventTarget();
function listener(this: EventTarget, event: Event) { same(this, target, "function receiver"); same(event.target, target, "event target"); }
const object = { handleEvent(this: unknown) { same(this, object, "object receiver"); } };
target.addEventListener("value", listener);
target.addEventListener("value", listener);
target.addEventListener("value", listener, true);
target.addEventListener("value", object);
const initial = getEventListeners(target, "value");
same(initial.length, 3, "duplicate/capture identity");
same(initial[0], listener, "original function");
same(initial[1], listener, "original capture function");
same(initial[2], object, "original object");
initial.length = 0;
same(getEventListeners(target, "value").length, 3, "fresh snapshot");
same(listenerCount(target, "value"), 3, "static target count");
target.dispatchEvent(new Event("value"));
target.removeEventListener("value", listener);
same(listenerCount(target, "value"), 2, "remove capture false");
target.removeEventListener("value", listener, true);
same(getEventListeners(target, "value")[0], object, "remove capture true");
target.removeEventListener("value", object);
same(listenerCount(target, "value"), 0, "empty count");
console.log("identity, capture, duplicates, receiver and fresh snapshots");

let handleReads = 0;
const dynamic = { get handleEvent() { handleReads++; return function (this: unknown) { same(this, dynamic, "dynamic object receiver"); }; } };
target.addEventListener("object", dynamic);
same(handleReads, 0, "handleEvent is not read during registration");
target.dispatchEvent(new Event("object"));
same(handleReads, 1, "handleEvent is read once per delivery");
target.removeEventListener("object", dynamic);
console.log("listener object getter is resolved once at delivery");

const reentrant = new EventTarget();
const calls: string[] = [];
const removed = () => calls.push("removed");
const late = () => calls.push("late");
reentrant.addEventListener("value", () => { calls.push("first"); reentrant.removeEventListener("value", removed); reentrant.addEventListener("value", late); }, { once: true });
reentrant.addEventListener("value", removed);
reentrant.addEventListener("value", () => { calls.push("once"); reentrant.dispatchEvent(new Event("value")); }, { once: true });
reentrant.dispatchEvent(new Event("value"));
same(calls.join(","), "first,once,late", "live removal and reentrant once");
same(getEventListeners(reentrant, "value")[0], late, "once removed before callback");
console.log("live removal, late registration and reentrant once");

const controller = new AbortController();
const order: string[] = [];
controller.signal.addEventListener("abort", event => { order.push("stopper"); event.stopImmediatePropagation(); });
const protectedListener = function (this: unknown, event: Event) { same(this, controller.signal, "protected receiver"); same(event.target, controller.signal, "protected event"); order.push("protected"); };
addAbortListener(controller.signal, protectedListener);
controller.signal.addEventListener("abort", () => order.push("ordinary"), { once: true });
const disposed = addAbortListener(controller.signal, () => order.push("disposed"));
disposed[Symbol.dispose]();
disposed[Symbol.dispose]();
controller.abort();
same(order.join(","), "stopper,protected", "protected propagation");
check(!getEventListeners(controller.signal, "abort").includes(protectedListener), "fired hook removed");
console.log("protected abort order, public stop and idempotent disposal");

const suppressed = new AbortController();
suppressed.signal.addEventListener("abort", event => event.stopImmediatePropagation());
const emitter = new EventEmitter();
const reason = new Error("abort reason");
const pending = once(emitter, "never", { signal: suppressed.signal });
suppressed.abort(reason);
same(emitter.listenerCount("never"), 0, "synchronous event cleanup");
same(emitter.listenerCount("error"), 0, "synchronous error cleanup");
try { await pending; throw new Error("Expected abort rejection"); }
catch (error) { check(error instanceof Error && error.name === "AbortError", "abort rejection"); same(error.cause, reason, "abort reason identity"); }
same(getEventListeners(suppressed.signal, "abort").length, 1, "once hook cleanup");
console.log("suppressed signal rejects once and cleans both emitter listeners");

const completed = new AbortController();
const delivered = once(emitter, "ready", { signal: completed.signal });
emitter.emit("ready", 42);
same((await delivered)[0], 42, "once delivery");
same(getEventListeners(completed.signal, "abort").length, 0, "completed wait removes abort hook");
const aborted = AbortSignal.abort();
let queued = false;
addAbortListener(aborted, () => { queued = true; });
same(queued, false, "already aborted hook is queued");
await Promise.resolve();
same(queued, true, "already aborted hook runs");
console.log("successful waits release abort hooks and pre-aborted hooks are queued");

const cancellation = new AbortController();
cancellation.signal.addEventListener("abort", event => event.stopImmediatePropagation());
const cancellable = new EventTarget();
cancellable.addEventListener("value", listener, { signal: cancellation.signal });
cancellation.abort();
same(getEventListeners(cancellable, "value").length, 0, "listener signal survives stopped abort");
const preAborted = new AbortController();
preAborted.abort();
cancellable.addEventListener("value", listener, { signal: preAborted.signal });
same(listenerCount(cancellable, "value"), 0, "pre-aborted registration absent");
console.log("registration signals cancel despite stopped abort and reject pre-aborted adds");

const released = new AbortController();
cancellable.addEventListener("value", listener, { signal: released.signal });
cancellable.removeEventListener("value", listener);
same(getEventListeners(released.signal, "abort").length, 0, "removed listener releases signal hook");
cancellable.addEventListener("value", () => {}, { once: true, signal: released.signal });
cancellable.dispatchEvent(new Event("value"));
same(getEventListeners(released.signal, "abort").length, 0, "once listener releases signal hook");
console.log("removed and fired registrations release signal hooks");

class GenuineTarget extends EventTarget {}
same(listenerCount(new GenuineTarget(), "value"), 0, "genuine subclass");
for (const value of [Object.create(EventTarget.prototype), new Proxy(target, {}), {}, null, 1]) {
  throwsTypeError(() => Reflect.apply(getEventListeners, undefined, [value, "value"]));
  throwsTypeError(() => Reflect.apply(listenerCount, undefined, [value, "value"]));
  throwsTypeError(() => Reflect.apply(addAbortListener, undefined, [value, () => {}]));
}
for (const value of [Object.create(AbortSignal.prototype), new Proxy(new AbortController().signal, {})]) {
  throwsTypeError(() => Reflect.apply(addAbortListener, undefined, [value, () => {}]));
}
console.log("genuine subclasses and forged or proxied brands");

let duckListener: (() => void) | undefined;
let duckRemoved = 0;
const duck = {
  aborted: false,
  addEventListener(_type: string, callback: () => void) { duckListener = callback; },
  removeEventListener(_type: string, callback: () => void) { same(callback, duckListener, "duck listener identity"); duckRemoved++; },
};
const duckHandle = Reflect.apply(addAbortListener, undefined, [duck, () => {}]);
check(typeof duckListener === "function", "duck registration");
duckHandle[Symbol.dispose]();
same(duckRemoved, 1, "duck disposal");
console.log("public duck signals retain ordinary registration and disposal");

const conversion: string[] = [];
const name = { toString() { conversion.push("type"); return "value"; } };
const options = { get capture() { conversion.push("capture"); return false; }, get once() { conversion.push("once"); return false; }, get passive() { conversion.push("passive"); return false; }, get signal() { conversion.push("signal"); return undefined; } };
Reflect.apply(cancellable.addEventListener, cancellable, [name, listener, options]);
same(conversion.join(","), "type,capture,once,passive,signal", "add conversion order");
conversion.length = 0;
Reflect.apply(cancellable.removeEventListener, cancellable, [name, listener, options]);
same(conversion.join(","), "type,capture", "remove conversion order");
conversion.length = 0;
Reflect.apply(getEventListeners, undefined, [cancellable, name]);
same(conversion.join(","), "type", "snapshot conversion order");
throwsTypeError(() => getEventListeners(cancellable, Symbol("value")));
console.log("Bun event-name conversion and option getter order");

const attributeSignal = new AbortController().signal;
same(Object.hasOwn(attributeSignal, "onabort"), false, "attribute has no initial own property");
const attributeDescriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "onabort");
check(attributeDescriptor?.enumerable && attributeDescriptor.configurable, "attribute descriptor");
same(attributeSignal.onabort, null, "default attribute");
const attributeOrder: string[] = [];
const beforeAttribute = () => attributeOrder.push("before");
const firstAttribute = () => attributeOrder.push("first");
const replacedAttribute = () => attributeOrder.push("replacement");
const afterAttribute = () => attributeOrder.push("after");
attributeSignal.addEventListener("abort", beforeAttribute);
attributeSignal.onabort = firstAttribute;
attributeSignal.addEventListener("abort", afterAttribute);
const oldAttributeSnapshot = getEventListeners(attributeSignal, "abort");
attributeSignal.onabort = replacedAttribute;
same(oldAttributeSnapshot[1], firstAttribute, "old snapshot retains value");
same(getEventListeners(attributeSignal, "abort")[1], replacedAttribute, "live attribute replacement");
attributeSignal.dispatchEvent(new Event("abort"));
same(attributeOrder.join(","), "before,replacement,after", "replacement retains order");
attributeOrder.length = 0;
attributeSignal.onabort = null;
attributeSignal.onabort = firstAttribute;
attributeSignal.dispatchEvent(new Event("abort"));
same(attributeOrder.join(","), "before,after,first", "reactivation appends");
console.log("onabort descriptor, ordered replacement, clear and snapshot values");

const mixedSignal = new AbortController().signal;
let mixedCalls = 0;
const mixed = () => { mixedCalls++; };
mixedSignal.onabort = mixed;
mixedSignal.addEventListener("abort", mixed, { once: true });
mixedSignal.addEventListener("abort", mixed);
mixedSignal.addEventListener("abort", mixed, true);
same(listenerCount(mixedSignal, "abort"), 3, "attribute and capture domains");
mixedSignal.dispatchEvent(new Event("abort"));
same(mixedCalls, 3, "mixed domains delivered");
same(listenerCount(mixedSignal, "abort"), 2, "normal once preserves attribute");
mixedSignal.removeEventListener("abort", mixed);
same(listenerCount(mixedSignal, "abort"), 2, "public remove ignores lone attribute");
mixedSignal.onabort = null;
same(listenerCount(mixedSignal, "abort"), 1, "attribute clear preserves capture registration");
mixedSignal.removeEventListener("abort", mixed, true);
same(listenerCount(mixedSignal, "abort"), 0, "independent capture removal");
console.log("attribute and ordinary duplicate, capture and once domains");

const inertSignal = new AbortController().signal;
let inertReads = 0;
const inert = { get handleEvent() { inertReads++; throw new Error("inert getter"); } };
Reflect.set(inertSignal, "onabort", inert);
same(inertSignal.onabort, inert, "original inert object");
same(getEventListeners(inertSignal, "abort")[0], inert, "inert snapshot");
same(listenerCount(inertSignal, "abort"), 1, "inert slot counts");
inertSignal.dispatchEvent(new Event("abort"));
same(inertReads, 0, "attribute never reads handleEvent");
for (const primitive of [undefined, null, false, true, 0, 1n, "value", Symbol("attribute")]) {
  Reflect.set(inertSignal, "onabort", inert);
  Reflect.set(inertSignal, "onabort", primitive);
  same(inertSignal.onabort, null, "primitive clears attribute");
  same(listenerCount(inertSignal, "abort"), 0, "clear removes visible slot");
}
console.log("inert attribute objects are visible without handleEvent access and primitives clear");

const liveAttribute = new AbortController().signal;
const liveOrder: string[] = [];
let changeAttribute = () => { liveAttribute.onabort = () => liveOrder.push("replacement"); };
liveAttribute.addEventListener("abort", () => changeAttribute());
liveAttribute.onabort = () => liveOrder.push("old");
liveAttribute.dispatchEvent(new Event("abort"));
same(liveOrder.join(","), "replacement", "replacement before turn is live");
liveOrder.length = 0;
changeAttribute = () => { liveAttribute.onabort = null; liveAttribute.onabort = () => liveOrder.push("new"); };
liveAttribute.dispatchEvent(new Event("abort"));
same(liveOrder.length, 0, "clear and re-add cannot revive snapshot slot");
changeAttribute = () => {};
liveAttribute.dispatchEvent(new Event("abort"));
same(liveOrder.join(","), "new", "new attribute starts on later dispatch");
console.log("live attribute replacement and removed-slot dispatch rules");

const shadowedSignal = new AbortController().signal;
let shadowCalls = 0, shadowReads = 0;
shadowedSignal.onabort = function (event) {
  same(this, shadowedSignal, "attribute receiver");
  same(arguments.length, 1, "attribute argument count");
  same(event.type, "abort", "attribute event");
  shadowCalls++;
};
Object.defineProperty(shadowedSignal.onabort, "call", { get() { throw new Error("call getter"); } });
Object.defineProperty(shadowedSignal.onabort, "apply", { get() { throw new Error("apply getter"); } });
Object.defineProperty(shadowedSignal, "onabort", { configurable: true, get() { shadowReads++; throw new Error("shadow getter"); } });
same(listenerCount(shadowedSignal, "abort"), 1, "private attribute count ignores shadow");
same(getEventListeners(shadowedSignal, "abort").length, 1, "private snapshot ignores shadow");
shadowedSignal.dispatchEvent(new Event("abort"));
same(shadowCalls, 1, "attribute delivered once");
same(shadowReads, 0, "shadow getter not observed");
console.log("private attribute dispatch ignores own shadows and callback call or apply properties");

for (const protectedFirst of [false, true]) {
  const source = new AbortController();
  const callback = () => {};
  source.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  if (protectedFirst) addAbortListener(source.signal, callback);
  else source.signal.addEventListener("abort", callback);
  addAbortListener(source.signal, callback);
  source.signal.addEventListener("abort", callback);
  same(listenerCount(source.signal, "abort"), 2, "protected duplicate identity");
  source.abort();
  same(listenerCount(source.signal, "abort"), protectedFirst ? 1 : 2, "public first is not promoted");
}
console.log("ordinary-first and protected-first duplicate options remain independent");

const removalSource = new AbortController();
const removalCallback = () => {};
const removalHandle = addAbortListener(removalSource.signal, removalCallback);
let removalGets = 0, removalCalls = 0;
const removalFailure = new Error("public remover");
Object.defineProperty(removalSource.signal, "removeEventListener", {
  configurable: true,
  get() {
    removalGets++;
    return function (type: string, callback: unknown) {
      same(this, removalSource.signal, "public remover receiver");
      same(arguments.length, 2, "public remover arguments");
      same(type, "abort", "public remover type");
      same(callback, removalCallback, "public remover original callback");
      removalCalls++;
    };
  },
});
removalHandle[Symbol.dispose](); removalHandle[Symbol.dispose]();
same(removalGets, 2, "fresh remover lookup each disposal");
same(removalCalls, 2, "repeated public disposal");
same(listenerCount(removalSource.signal, "abort"), 1, "no-op remover intentionally keeps listener");
Object.defineProperty(removalSource.signal, "removeEventListener", { get() { throw removalFailure; } });
for (let index = 0; index < 2; index++) {
  let observed: unknown;
  try { removalHandle[Symbol.dispose](); } catch (error) { observed = error; }
  same(observed, removalFailure, "remover exception identity");
}
same(listenerCount(removalSource.signal, "abort"), 1, "throwing remover intentionally keeps listener");
Reflect.apply(EventTarget.prototype.removeEventListener, removalSource.signal, ["abort", removalCallback]);
console.log("public disposal repeats current two-argument removal and preserves no-op or thrown behavior");

const hiddenSource = new AbortController();
const hiddenTarget = new EventTarget();
const hiddenCallback = () => {};
let publicHookCalls = 0;
const publicHookFailure = new Error("public hook");
for (const method of ["addEventListener", "removeEventListener"]) {
  Object.defineProperty(hiddenSource.signal, method, { get() { publicHookCalls++; throw publicHookFailure; } });
}
hiddenTarget.addEventListener("value", hiddenCallback, { signal: hiddenSource.signal });
same(listenerCount(hiddenSource.signal, "abort"), 0, "bound-listener algorithm is hidden");
hiddenTarget.removeEventListener("value", hiddenCallback);
hiddenTarget.addEventListener("value", hiddenCallback, { signal: hiddenSource.signal });
const combined = AbortSignal.any([hiddenSource.signal]);
same(getEventListeners(hiddenSource.signal, "abort").length, 0, "composition algorithm is hidden");
hiddenSource.abort(reason);
same(listenerCount(hiddenTarget, "value"), 0, "hidden cancellation removed entry");
same(combined.aborted, true, "hidden composition aborted");
same(combined.reason, reason, "composition reason identity");
same(publicHookCalls, 0, "automatic algorithms never use public source methods");
const laterAborted = AbortSignal.any([new AbortController().signal, AbortSignal.abort(reason)]);
same(laterAborted.reason, reason, "later pre-aborted input");
console.log("hidden cancellation and composition bypass public methods and preserve reason");

const passiveTarget = new EventTarget();
const owningSignal = new AbortController(), duplicateSignal = new AbortController();
const cancel = (event: Event) => event.preventDefault();
const savedOptions = { passive: true, once: false, capture: false, signal: owningSignal.signal };
passiveTarget.addEventListener("cancel", cancel, savedOptions);
passiveTarget.addEventListener("cancel", cancel, { passive: false, once: true, signal: duplicateSignal.signal });
savedOptions.capture = true;
duplicateSignal.abort();
const passiveEvent = new Event("cancel", { cancelable: true });
same(passiveTarget.dispatchEvent(passiveEvent), true, "first duplicate passive option retained");
same(passiveEvent.defaultPrevented, false, "passive callback cannot cancel");
same(listenerCount(passiveTarget, "cancel"), 1, "first duplicate once option retained");
owningSignal.abort();
same(listenerCount(passiveTarget, "cancel"), 0, "original signal and normalized capture retained");
console.log("passive, once, signal and capture options stay owned by first registration");

const activeTarget = new EventTarget();
const activeEvent = new Event("active");
let activeCalls = 0;
activeTarget.addEventListener("active", () => {
  activeCalls++;
  let activeError: unknown;
  try { activeTarget.dispatchEvent(activeEvent); } catch (error) { activeError = error; }
  check(activeError instanceof Error && Reflect.get(activeError, "code") === "ERR_EVENT_RECURSION", "active-event dispatch rejection");
});
activeTarget.dispatchEvent(activeEvent);
activeTarget.dispatchEvent(activeEvent);
same(activeCalls, 2, "dispatch state resets");
same(activeEvent.currentTarget, null, "currentTarget resets");
same(activeEvent.eventPhase, 0, "event phase resets");
console.log("active-event rejection and repeated-dispatch state reset");
