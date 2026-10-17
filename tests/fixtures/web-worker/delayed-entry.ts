import "./entry-gate.ts";
onmessage = event => { postMessage(event.data); close(); };
