export const handshake = "storage-firefox-observer-931cfb0e";
export type Association = { runtimeId: string; workerId: number };
export function association<T>(value: T): value is T & Association {
  if (!value || typeof value !== "object") return false;
  return "runtimeId" in value && typeof value.runtimeId === "string" && value.runtimeId.length >= 32
    && "workerId" in value && Number.isSafeInteger(value.workerId) && Number(value.workerId) > 0;
}
export function belongs<T>(value: T, own: Association): value is T & Association {
  return association(value) && value.runtimeId === own.runtimeId && value.workerId === own.workerId;
}

export function workerTransport(scope: DedicatedWorkerGlobalScope) {
  let own: Association | undefined;
  let port: MessagePort | undefined;
  const pending: object[] = [];
  const listeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
  const postMessage = (payload: object) => {
    if (!port || !own) { pending.push(payload); return; }
    port.postMessage({ ...own, payload });
  };
  function control(event: MessageEvent) {
    if (!own || !belongs(event.data, own)) {
      postMessage({ kind: "control-rejected", requested: event.data });
      return;
    }
    for (const listener of listeners) listener({ data: event.data.payload });
  }
  scope.addEventListener("message", event => {
    if (event.data?.diagnostic !== handshake) return;
    event.stopImmediatePropagation();
    if (own || !association(event.data) || event.ports.length !== 1) throw Error("invalid diagnostic Worker handshake");
    own = { runtimeId: event.data.runtimeId, workerId: event.data.workerId };
    port = event.ports[0]!;
    port.onmessage = control;
    postMessage({ kind: "transport-armed", workerURL: scope.location.href, workerIsolated: scope.crossOriginIsolated });
    for (const payload of pending.splice(0)) postMessage(payload);
  });
  return { postMessage, addEventListener(_type: "message", listener: (event: { data: Record<string, unknown> }) => void) { listeners.push(listener); } };
}
