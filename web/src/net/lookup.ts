import type { RuntimeNetwork, RuntimeNetworkLookupError } from "waffle";

interface LookupRequest {
  readonly type: "bun-dns-lookup";
  readonly id: number;
  readonly hostname: string;
  readonly family: 0 | 4 | 6;
  readonly hints: number;
}

interface LookupResponse {
  readonly type: "bun-dns-lookup-result";
  readonly id: number;
  readonly result?: { address: string; family: 4 | 6 }[];
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly syscall?: string;
    readonly hostname?: string;
  };
}

interface LookupEndpoint {
  postMessage(message: LookupRequest | LookupResponse): void;
  addEventListener(type: "message", listener: EventListener): void;
  removeEventListener(type: "message", listener: EventListener): void;
  start?(): void;
  close(): void;
}

export function installLookupServer(port: LookupEndpoint, network: Pick<RuntimeNetwork, "lookup">): () => void {
  const onMessage = (event: MessageEvent<LookupRequest>) => {
    const request = event.data;
    if (!request || request.type !== "bun-dns-lookup") return;
    try {
      const result = network.lookup(request.hostname, { family: request.family, hints: request.hints });
      port.postMessage({ type: "bun-dns-lookup-result", id: request.id, result } satisfies LookupResponse);
    } catch (error) {
      port.postMessage({ type: "bun-dns-lookup-result", id: request.id, error: serializeLookupError(error) } satisfies LookupResponse);
    }
  };
  port.addEventListener("message", onMessage as EventListener);
  port.start?.();
  return () => {
    port.removeEventListener("message", onMessage as EventListener);
    port.close();
  };
}

type LookupOperation = (hostname: string, family: 0 | 4 | 6, hints: number) => Promise<{ address: string; family: 4 | 6 }[]>;

export function trackLookup(lookup: LookupOperation, track: (promise: ReturnType<LookupOperation>) => ReturnType<LookupOperation>): LookupOperation {
  return (...args) => track(Promise.resolve().then(() => lookup(...args))).then(results => results);
}

export type LookupClient = LookupOperation & {
  close(): void;
};

export function createLookupClient(port: LookupEndpoint): LookupClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve(value: { address: string; family: 4 | 6 }[]): void; reject(error: unknown): void }>();
  const onMessage = (event: MessageEvent<LookupResponse>) => {
    const response = event.data;
    if (!response || response.type !== "bun-dns-lookup-result") return;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) {
      const error = Object.assign(new Error(response.error.message), response.error);
      Object.defineProperty(error, "name", { value: response.error.name, configurable: true, writable: true });
      waiter.reject(error);
      return;
    }
    waiter.resolve(response.result ?? []);
  };
  port.addEventListener("message", onMessage as EventListener);
  port.start?.();
  const lookup = ((hostname: string, family: 0 | 4 | 6, hints: number) => {
    if (closed) return Promise.reject(new Error("DNS lookup client is closed"));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ type: "bun-dns-lookup", id, hostname, family, hints });
    });
  }) as LookupClient;
  lookup.close = () => {
    if (closed) return;
    closed = true;
    port.removeEventListener("message", onMessage as EventListener);
    const error = new Error("DNS lookup client is closed");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    port.close();
  };
  return lookup;
}

function serializeLookupError(error: unknown): LookupResponse["error"] {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const source = error as Error & Partial<RuntimeNetworkLookupError>;
  return {
    name: source.name,
    message: source.message,
    code: source.code,
    syscall: source.syscall,
    hostname: source.hostname,
  };
}
