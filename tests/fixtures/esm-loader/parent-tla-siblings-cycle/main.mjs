// B and C both import A. B awaits a gate that C opens: C runs while B is suspended.
let open;
globalThis.gate = new Promise(resolve => { open = resolve; });
globalThis.openGate = open;
await import('./a.mjs');
console.log('main');
