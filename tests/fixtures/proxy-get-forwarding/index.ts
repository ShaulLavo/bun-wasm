// Proxy [[Get]] must retain each level's observable behavior when JSC forwards without recursion.
function check(name: string, actual: unknown, expected: unknown): void {
  console.log(Object.is(actual, expected) ? `ok ${name}` : `FAIL ${name}`);
}
function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  return undefined;
}
function chain<T extends object>(target: T, depth: number): T {
  let current: object = target;
  for (let level = 0; level < depth; level++) current = new Proxy(current, {});
  return current as T;
}
function isRevokedTypeError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return [
    "Proxy has already been revoked. No more operations are allowed to be performed on it",
    "revoked proxy",
    "Cannot perform 'get' on a proxy that has been revoked",
  ].includes(error.message);
}

const receiverTarget = { get self(): unknown { return this; } };
for (const depth of [1, 2, 50]) {
  const proxy = chain(receiverTarget, depth);
  check(`${depth}-proxy receiver`, proxy.self, proxy);
  const receiver = { depth };
  check(`${depth}-proxy explicit receiver`, Reflect.get(proxy, "self", receiver), receiver);
}

const trapTarget = { value: 10 };
let trapped: typeof trapTarget;
const trap = new Proxy(trapTarget, {
  get(target, key, receiver) {
    check("middle trap target", target, trapTarget);
    check("middle trap key", key, "value");
    check("middle trap receiver", receiver, trapped);
    return "trapped";
  },
});
trapped = chain(trap, 50);
check("middle trap result", trapped.value, "trapped");

const lookupOrder: string[] = [];
const lookupHandler = (label: string): ProxyHandler<object> => ({
  get get() { lookupOrder.push(label); return undefined; },
});
let ordered: object = { value: "ordered" };
for (const label of ["inner", "middle", "outer"]) ordered = new Proxy(ordered, lookupHandler(label));
check("handler getters forward to the target", (ordered as { value: string }).value, "ordered");
check("handler lookup order", lookupOrder.join(","), "outer,middle,inner");

const handlerOrder: string[] = [];
const proxyHandler = new Proxy({}, {
  get(target, key, receiver) {
    handlerOrder.push(String(key));
    return Reflect.get(target, key, receiver);
  },
});
const withProxyHandler = new Proxy({ value: "proxy handler" }, proxyHandler);
check("a Proxy can be the handler", withProxyHandler.value, "proxy handler");
check("Proxy handler lookup", handlerOrder.join(","), "get");

const revoked = Proxy.revocable({ value: 1 }, {});
const aroundRevoked = chain(revoked.proxy, 50);
revoked.revoke();
check("revoked middle Proxy", isRevokedTypeError(thrown(() => aroundRevoked.value)), true);

let deeper = Proxy.revocable({ value: 2 }, {});
const revokesDeeper = new Proxy(deeper.proxy, {
  get get() { deeper.revoke(); Bun.gc(true); return undefined; },
});
check("handler lookup revokes a deeper Proxy", isRevokedTypeError(thrown(() => revokesDeeper.value)), true);

let outer = Proxy.revocable({ value: 3 }, {});
outer = Proxy.revocable(chain(outer.proxy, 10), {
  get get() { outer.revoke(); return undefined; },
});
check("revoking an already visited outer Proxy has no effect", outer.proxy.value, 3);

let fresh = Proxy.revocable({ value: 4 }, {});
fresh = Proxy.revocable(fresh.proxy, {
  get get() {
    fresh.revoke();
    Bun.gc(true);
    return () => "fresh trap";
  },
});
check("a fresh trap survives revocation and collection", fresh.proxy.value, "fresh trap");

const dataTarget = {};
Object.defineProperty(dataTarget, "value", { value: 7, writable: false, configurable: false });
const badData = chain(new Proxy(dataTarget, { get: () => 8 }), 50);
check("trap-level data invariant", thrown(() => badData.value) instanceof TypeError, true);
const goodData = chain(new Proxy(dataTarget, { get: () => 7 }), 50);
check("matching data invariant result", goodData.value, 7);

const accessorTarget = {};
Object.defineProperty(accessorTarget, "value", { get: undefined, configurable: false });
const badAccessor = chain(new Proxy(accessorTarget, { get: () => 1 }), 50);
check("trap-level accessor invariant", thrown(() => badAccessor.value) instanceof TypeError, true);
const goodAccessor = chain(new Proxy(accessorTarget, { get: () => undefined }), 50);
check("matching accessor invariant result", goodAccessor.value, undefined);

const symbol = Symbol("key");
const keys = chain<Record<PropertyKey, unknown>>({ 0: "zero", [symbol]: "symbol" }, 50);
check("index key", keys[0], "zero");
check("symbol key", keys[symbol], "symbol");

function callable(): string { return "called"; }
callable.value = "property";
const callableChain = chain(callable, 50);
check("callable Proxy property", callableChain.value, "property");

const lookupFailure = new Error("handler lookup failed");
let throwing: object = { value: 5 };
for (let level = 0; level < 50; level++) {
  const handler: ProxyHandler<object> = level === 25 ? { get get(): undefined { throw lookupFailure; } } : {};
  throwing = new Proxy(throwing, handler);
}
check("handler exception at depth", thrown(() => (throwing as { value: number }).value), lookupFailure);

const mutableHandler: ProxyHandler<object> = {};
const mutableInner = new Proxy({ value: "default" }, mutableHandler);
let mutationPass = 0;
const mutableOuter = new Proxy(mutableInner, {
  get get() {
    mutationPass++;
    if (mutationPass === 1) mutableHandler.get = () => "added";
    if (mutationPass === 2) delete mutableHandler.get;
    if (mutationPass === 3) mutableHandler.get = () => "replaced";
    return undefined;
  },
});
check("handler lookup adds a deeper trap", mutableOuter.value, "added");
check("handler lookup removes a deeper trap", mutableOuter.value, "default");
check("handler lookup replaces a deeper trap", mutableOuter.value, "replaced");

const deep = chain({ value: 6 }, 200000);
check("deep forwarding reaches a catchable RangeError", thrown(() => deep.value) instanceof RangeError, true);
check("forwarding recovers after overflow", chain({ value: "recovered" }, 50).value, "recovered");
