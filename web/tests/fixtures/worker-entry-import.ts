const host = globalThis as typeof globalThis & { bunImportGate: Int32Array };
Atomics.store(host.bunImportGate, 0, 1);
Atomics.notify(host.bunImportGate, 0);
Atomics.wait(host.bunImportGate, 1, 0);
export function attachBunTerminal(): never { throw new Error("Selected process must not attach a terminal"); }
export class NestedHost { constructor() { throw new Error("Selected process must not construct its nested host"); } }
export function regionProvider(): never { throw new Error("Selected process must not acquire its nested provider"); }
