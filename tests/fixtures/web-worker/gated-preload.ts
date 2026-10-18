const gate = new BroadcastChannel("web-worker-preload");
postMessage("preload ready");
await new Promise<void>(resolve => {
  gate.onmessage = () => { gate.close(); resolve(); };
});
