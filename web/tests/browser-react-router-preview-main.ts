import { Previews } from '../src/preview';

const bridge = new URL(location.href).searchParams.get('bridge');
if (!bridge) throw new Error('Missing native fixture bridge');
const previews = new Previews();
previews.register(5173, {
  request(_port, request, sink) {
    void fetch(`/__native${request.target}`, {
      method: request.method, headers: request.headers,
      body: request.body ? Uint8Array.from(request.body) : undefined,
    }).then(async response => {
      sink.head({ status: response.status, statusText: response.statusText, headers: Array.from(response.headers) });
      const reader = response.body?.getReader();
      if (reader) await forward(reader, sink.data);
      sink.end();
    }).catch(error => sink.error(String(error)));
    return true;
  },
  connect(_port, sink) {
    const socket = new WebSocket(bridge);
    socket.binaryType = 'arraybuffer';
    const queued: Uint8Array<ArrayBuffer>[] = [];
    let closed = false;
    socket.onopen = () => { for (const chunk of queued) socket.send(chunk); queued.length = 0; };
    socket.onmessage = event => { if (!closed && event.data instanceof ArrayBuffer) void sink.data(new Uint8Array(event.data)); };
    socket.onclose = () => { if (!closed) sink.end(); };
    socket.onerror = () => { if (!closed) sink.error('React Router native bridge failed'); };
    return {
      write(chunk) { if (socket.readyState === WebSocket.OPEN) socket.send(Uint8Array.from(chunk)); else queued.push(Uint8Array.from(chunk)); },
      close() { closed = true; socket.close(); },
    };
  },
});
Reflect.set(globalThis, 'routerPreviewReady', previews.ready);

async function forward(reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>, send: (chunk: Uint8Array<ArrayBuffer>) => void | Promise<void>): Promise<void> {
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    await send(value);
  }
}
