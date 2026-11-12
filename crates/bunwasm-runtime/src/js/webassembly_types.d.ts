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
    laneCreate(): [slot: number, generation: number];
    laneCell(): [index: number, generation: number];
    laneTransferEpoch(slot: number, generation: number, side: number): number;
    laneTransfer(slot: number, generation: number, side: number, kind: number, first: number, second: number, third: number): void;
    laneAdopt(slot: number, generation: number, side: number, epoch: number, version: number): boolean;
    laneReserve(slot: number, generation: number, side: number, text: string): number;
    laneCommit(id: number): boolean;
    laneAbort(id: number): void;
    laneDrain(slot: number, generation: number, side: number, limit: number): [frames: string[], more: boolean, terminal: boolean];
    laneCloseRead(slot: number, generation: number, side: number): void;
    laneCloseEnd(slot: number, generation: number, side: number): boolean;
    lanePeerClosed(slot: number, generation: number, side: number): boolean;
    laneEnd(slot: number, generation: number, side: number): [state: number, version: number];
    laneSever(slot: number, generation: number, side: number): void;
    laneExited(cell: number, generation: number): void;
    laneSweep(full: boolean): void;
    laneCensus(): GroupLaneCensus | null;
    laneClosures(): number;
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
