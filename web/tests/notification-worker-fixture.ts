/** Waffle 0.0.103 starts one short-lived notification worker per process. */
export function isNotificationWorkerUrl(url: string | URL): boolean {
  return String(url).endsWith("/notification-worker.js");
}

export function isNotificationBridgeRequest(value: unknown): value is { port: MessagePort; state: unknown } {
  return typeof value === "object" && value !== null && "port" in value && value.port instanceof MessagePort && "state" in value;
}
