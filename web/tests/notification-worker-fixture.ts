/** Waffle 0.0.154 runs one shared notification relay Worker per page. */
export function isNotificationWorkerUrl(url: string | URL): boolean {
  return String(url).endsWith("/notification-worker.js");
}

/** A bridge joining the relay: `{ id, port, state }`. Matches only an actual MessagePort. */
export function isNotificationBridgeRequest(value: unknown): value is { port: MessagePort; state: unknown } {
  return typeof value === "object" && value !== null && "port" in value && value.port instanceof MessagePort && "state" in value;
}

/**
 * Removing a bridge that is not the relay's last posts `{ drop: id }` and waits for the relay to answer
 * `{ id, type: "dropped" }`. A fake Worker that plays the relay answers it here and returns true, so a
 * page with two roots can dispose, and the message is never mistaken for a run request.
 */
export function answerNotificationRelayDrop(worker: object, message: unknown): boolean {
  if (typeof message !== "object" || message === null || !("drop" in message) || typeof message.drop !== "number") return false;
  const id = message.drop;
  queueMicrotask(() => {
    const onmessage: unknown = Reflect.get(worker, "onmessage");
    if (typeof onmessage === "function") onmessage.call(worker, { data: { id, type: "dropped" } });
  });
  return true;
}
