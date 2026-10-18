const gate = new BroadcastChannel("web-worker-entry");
await new Promise<void>(resolve => {
  gate.onmessage = () => { gate.close(); resolve(); };
  postMessage("dependency ready");
});
