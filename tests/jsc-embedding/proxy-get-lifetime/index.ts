interface Marker {
  marker: string;
}

function makeRevokingProxy(): object {
  const fresh = Proxy.revocable<Marker>({ marker: "target" }, {
    marker: "handler",
    get get() {
      fresh.revoke();
      return function (this: Marker, target: Marker, key: PropertyKey, receiver: Marker): string {
        return [this.marker, target.marker, String(key), receiver.marker].join(",");
      };
    },
  } as ProxyHandler<Marker> & Marker);
  return fresh.proxy;
}

const expected = "handler,target,bunWasmNativeLifetime,receiver";
const actual = Reflect.get(makeRevokingProxy(), "bunWasmNativeLifetime", { marker: "receiver" });
console.log(actual === expected ? "ok native-only handler and fresh trap" : `FAIL native-only handler and fresh trap: ${String(actual)}`);
