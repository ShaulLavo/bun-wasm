// lib.dom hides Bun's documented options overload. This native fixture runs only in Bun.
declare const WebSocket: { new(url: string | URL, options: Bun.WebSocketOptions): globalThis.WebSocket };

export function nativeWebSocket(url: string | URL, protocols: string[], origin: string): globalThis.WebSocket {
  return new WebSocket(url, { protocols, headers: { origin } });
}
