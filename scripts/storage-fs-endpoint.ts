import type { FilesystemConnection } from "../web/node_modules/waffle/fs/protocol.js";
import { requestTransportError } from "../web/node_modules/waffle/fs/request-memory.js";

type CloseReason = NonNullable<ReturnType<typeof requestTransportError>>["reason"];
type Frame =
  | {
      kind: "segment";
      index: number;
      bytes: number;
      maximum: number;
      growable: boolean;
      inherited: boolean;
    }
  | { kind: "request"; id: number; generation: number; privateBytes: number }
  | { kind: "completion"; id: number }
  | { kind: "transportClosed" | "discard" | "trim" | "sweep" | "other" };

export interface EndpointContext {
  tree: string;
  realm: string;
  endpoint: "client" | "service";
  workerURL: string;
}

/** Test-only. Install on the actual port before its original constructor installs handlers.
 * No connection, frame, buffer or callback escapes in a snapshot. This is not guest code. */
export function observeFilesystemEndpoint(
  connection: FilesystemConnection,
  context: EndpointContext,
  changed: (afterHandler?: boolean) => void = () => {},
  failed: (error: unknown) => void = () => {},
) {
  function reportFailure(error: unknown): void {
    try { failed(error); } catch {}
  }
  function notify(afterHandler = false): void {
    try { changed(afterHandler); }
    catch (error) { reportFailure(error); }
  }
  const port = connection.port;
  if (port.onmessage || port.onmessageerror) throw Error("endpoint observer installed too late");
  const inherited = connection.segments.map((buffer) => !!buffer);
  const originalSend = port.postMessage;
  const originalClose = port.close;
  let handlersQualified = false;
  let sends = 0;
  let receives = 0;
  let requestSends = 0;
  let requestReceives = 0;
  let sequence = 0;
  let lastSend: Frame | null = null;
  let lastReceive: Frame | null = null;
  const history: { sequence: number; event: string; frame: Frame | null; trusted: boolean | null; result: string | null }[] = [];
  let historyDropped = 0;
  function trace(event: string, frame: Frame | null = null, trusted: boolean | null = null, result: string | null = null): void {
    sequence++;
    if (history.length === 128) { historyDropped++; return; }
    history.push(Object.freeze({ sequence, event, frame, trusted, result }));
  }
  function word(buffer: SharedArrayBuffer | undefined, index = 0): number | null {
    if (!buffer) return null;
    try { return Atomics.load(new Int32Array(buffer), index); }
    catch (error) { reportFailure(error); return null; }
  }
  const authority = () => ({ identityRevocation: word(connection.revocations[0]), serviceRevocation: word(connection.ownerStates), ownerState: word(connection.ownerStates, connection.owner) });
  type FirstEvent = {
    kind: "messageerror" | "transportClosed" | "shared-closed" | "send-error";
    sequence: number;
    trusted: boolean | null;
    closedBefore: CloseReason | null;
    lastSend: Frame | null;
    lastReceive: Frame | null;
    identityRevocation: number | null;
    serviceRevocation: number | null;
    ownerState: number | null;
  };
  let first: FirstEvent | null = null;
  function inspectFrame(value: unknown): Frame {
    try { return Object.freeze(describeFrame(value, inherited)); }
    catch (error) { reportFailure(error); return { kind: "other" }; }
  }
  const closed = () => requestTransportError(connection.requests)?.reason ?? null;
  function record(kind: FirstEvent["kind"], trusted: boolean | null): void {
    if (first) return;
    first = Object.freeze({ kind, sequence, trusted, closedBefore: closed(), lastSend, lastReceive, ...authority() });
    notify(true);
  }
  function message(event: MessageEvent<unknown>): void {
    receives++;
    lastReceive = inspectFrame(event.data);
    trace("message", lastReceive, event.isTrusted);
    if (lastReceive.kind === "request") requestReceives++;
    if (receives === 1 || (lastReceive.kind === "request" && requestReceives === 1)) notify();
    if (lastReceive.kind === "transportClosed") record("transportClosed", event.isTrusted);
  }
  function messageerror(event: MessageEvent<unknown>): void {
    trace("messageerror", null, event.isTrusted);
    record("messageerror", event.isTrusted);
  }
  const send: MessagePort["postMessage"] = function (
    this: MessagePort,
    ...args: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]
  ) {
    if (this !== port) return Reflect.apply(originalSend, this, args);
    lastSend = inspectFrame(args[0]);
    const frame = lastSend;
    trace("send-call", frame);
    try {
      const result = Reflect.apply(originalSend, this, args);
      trace("send-return", null, null, typeof result);
      sends++;
      if (frame.kind === "request") requestSends++;
      if (sends === 1 || (frame.kind === "request" && requestSends === 1)) notify();
      return result;
    } catch (error) {
      trace("send-error");
      record("send-error", null);
      throw error;
    }
  };
  const close: MessagePort["close"] = function (this: MessagePort, ...args: []) {
    if (this !== port) return Reflect.apply(originalClose, this, args);
    trace("close-call");
    try {
      const result = Reflect.apply(originalClose, this, args);
      trace("close-return", null, null, typeof result);
      notify(true);
      return result;
    } catch (error) {
      trace("close-error");
      notify(true);
      throw error;
    }
  };
  port.addEventListener("message", message);
  port.addEventListener("messageerror", messageerror);
  port.postMessage = send;
  port.close = close;
  return {
    qualifyHandlers() {
      if (typeof port.onmessage !== "function" || typeof port.onmessageerror !== "function")
        throw Error("original endpoint handlers were not installed");
      handlersQualified = true;
      notify();
    },
    snapshot() {
      if (closed() && !first) record("shared-closed", null);
      return {
        ...context,
        owner: connection.owner,
        generation: connection.requests.generation,
        resident: connection.residentPublication?.kind ?? null,
        publication: !!connection.publication,
        handlersQualified,
        sends,
        receives,
        requestSends,
        requestReceives,
        lastSend,
        lastReceive,
        first,
        closed: closed(),
        ...authority(),
        history: history.slice(),
        historyDropped,
        historyLimit: 128,
      };
    },
    dispose() {
      port.removeEventListener("message", message);
      port.removeEventListener("messageerror", messageerror);
      if (port.postMessage !== send) throw Error("endpoint observer send hook was replaced");
      port.postMessage = originalSend;
      if (port.close !== close) throw Error("endpoint observer close hook was replaced");
      port.close = originalClose;
    },
  };
}

function describeFrame(value: unknown, inherited: readonly boolean[]): Frame {
  if (!value || typeof value !== "object") return { kind: "other" };
  if ("segment" in value && typeof value.segment === "number" && "buffer" in value)
    return describeSegment(value.segment, value.buffer, inherited);
  if ("transportClosed" in value) return { kind: "transportClosed" };
  if ("completed" in value && typeof value.completed === "number")
    return { kind: "completion", id: value.completed };
  if (
    "id" in value &&
    typeof value.id === "number" &&
    "generation" in value &&
    typeof value.generation === "number"
  )
    return {
      kind: "request",
      id: value.id,
      generation: value.generation,
      privateBytes: privateBytes(value),
    };
  if ("discard" in value) return { kind: "discard" };
  if ("trim" in value) return { kind: "trim" };
  if ("sweep" in value) return { kind: "sweep" };
  return { kind: "other" };
}
function privateBytes(value: object): number {
  return "payload" in value && value.payload instanceof ArrayBuffer ? value.payload.byteLength : 0;
}
function describeSegment(index: number, buffer: unknown, inherited: readonly boolean[]): Frame {
  if (!(buffer instanceof SharedArrayBuffer)) return { kind: "other" };
  return {
    kind: "segment",
    index,
    bytes: buffer.byteLength,
    maximum: buffer.maxByteLength,
    growable: buffer.growable,
    inherited: !!inherited[index - 1],
  };
}

export type EndpointSnapshot = ReturnType<ReturnType<typeof observeFilesystemEndpoint>["snapshot"]>;
