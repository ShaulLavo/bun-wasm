import { afterEach, expect, test } from "bun:test";
import { createSharedObjectBroker } from "../web/src/shared-objects/broker";
import { createSharedObjects } from "../web/src/shared-objects/service";
import { bindSharedObjectHost } from "../web/src/shared-objects/host";
import { sourcePorts, type SourcePort } from "./fixtures/shared-objects/source-runtime";

const cleanup = new Set<() => void>();
afterEach(async () => {
  for (const close of Array.from(cleanup).reverse()) close();
  cleanup.clear();
  await new Promise<void>(resolve => setImmediate(resolve));
});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function setup() {
  const broker = createSharedObjectBroker();
  cleanup.add(broker.dispose);
  function client() {
    const lease = broker.register(), channel = new MessageChannel();
    lease.attach(channel.port2);
    const service = createSharedObjects(lease.id, channel.port1);
    const sharedObjects = bindSharedObjectHost(service, { active: () => true, pending() {}, wake() {} });
    const runtime = sourcePorts({ sharedObjects });
    cleanup.add(() => { service.close(); lease.close(); channel.port1.close(); channel.port2.close(); });
    return { service, sharedObjects, runtime };
  }
  return { broker, client };
}
function restoredPort(value: unknown, runtime: ReturnType<typeof sourcePorts>): SourcePort {
  if (!value || typeof value !== "object" || !("postMessage" in value) || typeof value.postMessage !== "function") throw new Error("Missing restored source port");
  // The factory validates port identity through its public receive operation.
  runtime.receiveMessageOnPort(value as SourcePort);
  return value as SourcePort;
}
test("source factory routes through host wrapper broker mailbox to a genuinely restored port", async () => {
  const { client } = setup();
  const sender = client(), receiver = client();
  const channel = new sender.runtime.MessageChannel();
  cleanup.add(() => channel.port1.close());
  const graph = sender.runtime.codec.encode(channel.port2, [channel.port2]);
  const restored = restoredPort(receiver.runtime.codec.decode(graph), receiver.runtime);
  cleanup.add(() => restored.close());
  await tick();
  channel.port1.postMessage({ answer: "42 λ 😀" });
  await tick();
  expect(receiver.runtime.receiveMessageOnPort(restored)).toEqual({ message: { answer: "42 λ 😀" } });
  restored.postMessage("reply");
  await tick();
  expect(sender.runtime.receiveMessageOnPort(channel.port1)).toEqual({ message: "reply" });
});
