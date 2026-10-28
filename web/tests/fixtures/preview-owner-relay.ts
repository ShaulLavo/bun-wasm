import { connect } from "node:net";
import { createPreviewHostRelay } from "waffle/browser/preview-host";
import type { PreviewServer } from "waffle/browser/preview";
import type { OwnerBinding } from "../../src/preview-owner-client";

/** The real Waffle dispatcher, connected only to this fixture's native TCP server. */
export function nativeBinding(options: { owner: string; origin: string; port: number; target: string; signal: AbortSignal }): OwnerBinding {
  const endpoint = new URL(options.target);
  const server: Pick<PreviewServer, "connect"> = { connect(port, sink) {
    if (port !== options.port) return null;
    const socket = connect(Number(endpoint.port), endpoint.hostname);
    let closed = false;
    socket.on("data", chunk => {
      const pending = sink.data(typeof chunk === "string" ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk));
      if (!pending) return;
      socket.pause();
      void pending.then(() => { if (!closed) socket.resume(); }, () => socket.destroy());
    });
    socket.on("end", () => { if (!closed) sink.end(); });
    socket.on("error", () => { if (!closed) sink.error("Native fixture connection failed"); });
    return {
      write(chunk) { if (!closed) socket.write(chunk); },
      close() { closed = true; socket.destroy(); },
    };
  } };
  const relay = createPreviewHostRelay(server, options.owner, { origin: options.origin, port: options.port, signal: options.signal });
  return { authorization: relay.authorization, dispatcher: relay, close: () => relay.close() };
}
