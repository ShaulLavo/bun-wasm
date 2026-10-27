import type { PreviewServer } from "waffle/browser/preview";

interface PreviewPath { sequence: number; port: number; method: string; target: string }

/** Test-only byte observer. Forward the original bytes and retain no headers or body. */
export function observePreviewPaths(): void {
  const playground: unknown = Reflect.get(globalThis, "playground");
  if (!playground || typeof playground !== "object" || !("previews" in playground)) throw new Error("Missing preview router");
  const router = playground.previews;
  if (!router || typeof router !== "object" || !("register" in router) || typeof router.register !== "function" || !("unregister" in router) || typeof router.unregister !== "function") throw new Error("Invalid preview router");
  const register = router.register.bind(router), unregister = router.unregister.bind(router);
  const bindings = new Map<number, { original: PreviewServer; observed: PreviewServer }>();
  const paths: PreviewPath[] = [];
  let sequence = 0;
  router.register = (port: number, server: PreviewServer) => {
    const observed: PreviewServer = {
      request: (port, request, sink) => server.request(port, request, sink),
      connect(port, sink) {
        const connection = server.connect(port, sink);
        if (!connection) return null;
        let first = true;
        return {
          write(chunk) {
            if (first) {
              first = false;
              const line = new TextDecoder().decode(Uint8Array.from(chunk.subarray(0, 2048))).split("\r\n", 1)[0] ?? "";
              const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
              if (match?.[1] && match[2]) paths.push({ sequence: ++sequence, port, method: match[1], target: match[2].split(/[?#]/, 1)[0] ?? "/" });
              if (paths.length > 4096) paths.shift();
            }
            connection.write(chunk);
          },
          close: () => connection.close(),
        };
      },
    };
    bindings.set(port, { original: server, observed });
    register(port, observed);
  };
  router.unregister = (port: number, server: PreviewServer) => {
    const binding = bindings.get(port);
    if (binding?.original !== server) { unregister(port, server); return; }
    bindings.delete(port);
    unregister(port, binding.observed);
  };
  Reflect.set(globalThis, "__matrixPreviewPaths", paths);
  Reflect.set(globalThis, "__matrixPreviewPorts", () => Array.from(bindings.keys()));
}

export function readPreviewPaths(): PreviewPath[] {
  const value: unknown = Reflect.get(globalThis, "__matrixPreviewPaths");
  if (!Array.isArray(value)) throw new Error("Preview path observer is unavailable");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("sequence" in entry) || typeof entry.sequence !== "number" || !("port" in entry) || typeof entry.port !== "number" || !("method" in entry) || typeof entry.method !== "string" || !("target" in entry) || typeof entry.target !== "string") throw new Error("Invalid preview path observation");
    return { sequence: entry.sequence, port: entry.port, method: entry.method, target: entry.target };
  });
}


export function readPreviewPorts(): number[] {
  const read: unknown = Reflect.get(globalThis, "__matrixPreviewPorts");
  if (typeof read !== "function") throw new Error("Preview port observer is unavailable");
  const value: unknown = read();
  if (!Array.isArray(value) || !value.every(port => typeof port === "number")) throw new Error("Invalid preview port observation");
  return value;
}
