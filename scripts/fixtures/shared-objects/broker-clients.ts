import { afterEach } from "bun:test";
import { createSharedObjectBroker } from "../../../web/src/shared-objects/broker";
import { createSharedObjects } from "../../../web/src/shared-objects/service";
import { bindSharedObjectHost } from "../../../web/src/shared-objects/host";
import type { SharedRequest, SharedResponse } from "../../../web/src/shared-objects/protocol";
import { sourcePorts } from "./source-runtime";

/** Closers run in reverse after each test of the calling file. */
export function testCleanup(): Set<() => void> {
  const cleanup = new Set<() => void>();
  afterEach(async () => {
    for (const close of Array.from(cleanup).reverse()) close();
    cleanup.clear();
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  return cleanup;
}

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

interface ClientOptions { beforeDetach?: () => void; active?: () => boolean; observe?: (packet: SharedRequest | SharedResponse) => void }

/**
 * One in-process broker and source-runtime clients connected to it. Without lanes, port packets
 * take the broker route that lanes fall back to.
 */
export function brokerClients(cleanup: Set<() => void>, options: { lanes: boolean }) {
  const broker = createSharedObjectBroker();
  cleanup.add(broker.dispose);
  function client(clientOptions: ClientOptions = {}) {
    const lease = broker.register(), channel = new MessageChannel();
    lease.attach(channel.port2);
    const service = createSharedObjects(lease.id, {
      postMessage(packet) { clientOptions.observe?.(packet); channel.port1.postMessage(packet); },
      start: () => channel.port1.start(), close: () => channel.port1.close(),
      addEventListener: (type, listener) => channel.port1.addEventListener(type, listener),
      removeEventListener: (type, listener) => channel.port1.removeEventListener(type, listener),
    });
    const bound = options.lanes ? service : { ...service, lanes: undefined };
    const sharedObjects = bindSharedObjectHost(bound, { active: clientOptions.active ?? (() => true), pending() {}, wake() {} });
    const runtime = sourcePorts({ sharedObjects, beforeDetach: clientOptions.beforeDetach });
    cleanup.add(() => { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); });
    return { service, sharedObjects, runtime };
  }
  return { broker, client };
}
