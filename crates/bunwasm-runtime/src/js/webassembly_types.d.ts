declare namespace BunWasm {
  type WasmType = 'v128' | 'i32' | 'i64' | 'f32' | 'f64' | 'funcref' | 'externref';
  type WasmElement = 'funcref' | 'externref';
  type WasmReference = { kind: 'function' | 'externref'; id: number };
  type WasmValue = number | bigint | WasmReference | null;
  interface WasmFunction { backend?: "nested"; id: number; params: WasmType[]; results: WasmType[] }
  type WasmExport = { name: string; index?: number } & (
    { kind: 'function'; params: WasmType[]; results: WasmType[] } |
    { kind: 'memory' } | { kind: 'table'; element: WasmElement } |
    { kind: 'global'; type: WasmType; mutable: boolean }
  );
  type WasmImport = WasmExport & { module: string };
  interface WasmModule { backend?: "nested"; id: number; imports: WasmImport[]; exports: WasmExport[] }
  interface WasmTable { backend?: "nested"; id: number; element: WasmElement }
  type WasmCall = { values: WasmValue[] } | { call: number; import: number; args: WasmValue[] };
  interface WasmNative {
    sharedMemorySupported(): boolean;
    nestedCallbackLimit(): number;
    createSharedMemory(initial: number, maximum: number): number;
    publishSharedMemory(id: number): number;
    attachSharedMemory(token: number): number;
    publishSharedModule(id: number): number;
    attachSharedModule(token: number): WasmModule;
    withdrawShared(token: number): number;
    laneLedger(): number;
    laneJoin(ledger: number, cell: number, generation: number): boolean;
    /** These three and `laneCensus` cross the allocating bridge and may throw; a word native settles what they left. */
    laneReserve(slot: number, generation: number, side: number, text: string): void;
    laneDrain(slot: number, generation: number, side: number, limit: number): [frames: string[], more: boolean, terminal: boolean];
    laneRefusal(): string;
    laneCensus(): GroupLaneCensus | null;
    /**
     * Word natives from here on: numbers in, one number out, and neither the call nor the return
     * can throw. A flag is 0 or 1; a refusable one returns -1 and `laneRefusal` says why.
     */
    /** `slot * 2 ** 28 + generation`, or -1. */
    laneCreate(): number;
    /** `index * 2 ** 28 + generation`, or -1. */
    laneCell(): number;
    laneTransferEpoch(slot: number, generation: number, side: number): number;
    laneTransfer(slot: number, generation: number, side: number, kind: number, first: number, second: number, third: number): number;
    laneAdopt(slot: number, generation: number, side: number, epoch: number, version: number): number;
    laneCommit(slot: number, generation: number, side: number): number;
    laneAbort(slot: number, generation: number, side: number): number;
    laneDrained(slot: number, generation: number, side: number): number;
    laneCloseRead(slot: number, generation: number, side: number): number;
    laneCloseEnd(slot: number, generation: number, side: number): number;
    lanePeerClosed(slot: number, generation: number, side: number): number;
    /** `version * 16 + state`. */
    laneEnd(slot: number, generation: number, side: number): number;
    laneSever(slot: number, generation: number, side: number): number;
    laneExited(cell: number, generation: number): number;
    laneSweep(full: boolean): number;
    laneEpochs(): number;
    validate(bytes: Uint8Array): boolean;
    compile(bytes: Uint8Array): WasmModule;
    instantiate(id: number, bindings: (number | bigint | null | WasmReference | { kind: 'callback'; id: number })[], invocation?: number): number;
    functionIdentity(id: number, name: string): WasmFunction;
    functionInfo(id: number): WasmFunction;
    call(id: number, args: WasmValue[], invocation?: number): WasmCall;
    resume(id: number, args: WasmValue[]): WasmCall;
    cancel(id: number): void;
    createTable(element: WasmElement, initial: number, maximum: number | undefined, value: WasmValue): WasmTable;
    tableIdentity(id: number, name: string): WasmTable;
    tableLength(id: number): number;
    tableGet(id: number, index: number): WasmValue;
    tableSet(id: number, index: number, value: WasmValue): void;
    tableGrow(id: number, count: number, value: WasmValue): number;
    createMemory(initial: number, maximum?: number): number;
    memoryIdentity(id: number, name: string): number;
    memorySpan(id: number): { pointer: number; length: number; generation: bigint; shared?: boolean; maximum?: number };
    growMemory(id: number, count: number): number;
    global(id: number, name: string, value?: WasmValue): WasmValue;
  }
  interface WasmInternal {
    native: { wasm: WasmNative; wasmMemoryBuffer(resource: number, previous: ArrayBuffer | undefined): ArrayBuffer; wasmSharedMemoryBuffer(resource: number, visible?: number): SharedArrayBuffer; sharedBufferResource?(buffer: SharedArrayBuffer): number | undefined; wasmNestedExecute<T>(operation: (token: number) => T, callback: (id: number, args: WasmValue[]) => { type: WasmType; value: WasmValue }[]): T };
    isWasmMemoryBuffer?: (value: unknown) => boolean;
    isWasmCapability?: (value: unknown) => boolean;
    /** Same-region Module and Memory transport between members of one group. */
    groupSharedObjects?: SharedObjects;
  }
  interface Native { wasm: WasmNative }
}
