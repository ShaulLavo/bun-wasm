// Native hostname lookup over the shared nonblocking host ABI.
(function (internal: BunWasm.Internal) {
  "use strict";

  const AGAIN = -2;
  type HostLookup = NonNullable<BunWasm.Native["hostLookup"]>;
  type LookupAddress = Awaited<ReturnType<HostLookup>>[number];
  type LookupWaiter = BunWasm.IoWaiter & { cancel(): void };
  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
  }

  function invalidResult(message: string): TypeError {
    return Object.assign(new TypeError(`Invalid native hostname lookup result: ${message}`), {
      code: "ERR_INVALID_HOST_LOOKUP",
    });
  }

  function parseAddress(value: unknown): LookupAddress {
    if (!isRecord(value)) throw invalidResult("address is not an object");
    const address = value.address;
    const family = value.family;
    if (typeof address !== "string") throw invalidResult("address is not a string");
    if (family !== 4 && family !== 6) throw invalidResult("family is not 4 or 6");
    return { address, family };
  }

  function parseHead(text: string): LookupAddress[] {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalidResult("response is not JSON");
    }
    if (!isRecord(value) || !Array.isArray(value.addresses)) throw invalidResult("addresses is not an array");
    return value.addresses.map(parseAddress);
  }

  function installLookup(net: BunWasm.NetWaiterModule): void {
    const native = internal.native;
    if (typeof native.hostLookup === "function") return;
    const required = ["poll", "lookup_start", "lookup_head", "error", "close"];
    if (!required.every((name) => native.hostCaps[name])) return;
    const start = native.hostLookupStart;
    const head = native.hostLookupHead;
    if (typeof start !== "function" || typeof head !== "function") return;
    const startLookup = start;
    const readHead = head;

    const lookup: HostLookup = (hostname, family, hints) => new Promise<LookupAddress[]>((resolve, reject) => {
      let handle = 0;
      let closed = false;
      let settled = false;
      let waiter: LookupWaiter | undefined;

      function close(): void {
        if (closed || handle <= 0) return;
        closed = true;
        native.hostClose(handle);
      }

      function remove(): void {
        if (!waiter) return;
        net.removeWaiter(waiter);
        waiter = undefined;
      }

      function settle(action: () => void): void {
        if (settled) return;
        settled = true;
        remove();
        try {
          close();
        } finally {
          action();
        }
      }

      function fail(error: unknown): void {
        settle(() => reject(error));
      }

      function step(): boolean {
        if (settled) return true;
        const result = readHead(handle);
        if (result === AGAIN) return false;
        if (typeof result === "number") {
          fail(net.hostError(handle, "hostname lookup failed"));
          return true;
        }
        try {
          const addresses = parseHead(result);
          settle(() => resolve(addresses));
        } catch (error) {
          fail(error);
        }
        return true;
      }

      function cancel(): void {
        if (settled) return;
        settled = true;
        remove();
        close();
      }

      try {
        handle = startLookup(hostname, family, hints);
        if (handle < 0) {
          reject(net.hostError(0, "hostname lookup failed"));
          return;
        }
        waiter = net.addWaiter({ ref: true, step, fail, cancel });
      } catch (error) {
        close();
        reject(error);
      }
    });
    native.hostLookup = lookup;
  }

  function install(): void {
    installLookup(internal.require("net"));
  }

  return { install, cancel: () => internal.require("net").cancelIoWaiters() };
})
