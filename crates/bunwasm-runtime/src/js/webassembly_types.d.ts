declare namespace BunWasm {
  type WasmType = 'v128' | 'i32' | 'i64' | 'f32' | 'f64' | 'funcref' | 'externref';
  type WasmElement = 'funcref' | 'externref';
  type WasmReference = { kind: 'function' | 'externref'; id: number };
  type WasmValue = number | bigint | WasmReference | null;
  interface WasmFunction { id: number; params: WasmType[]; results: WasmType[] }
  type WasmExport = { name: string } & (
    { kind: 'function'; params: WasmType[]; results: WasmType[] } |
    { kind: 'memory' } | { kind: 'table'; element: WasmElement } |
    { kind: 'global'; type: WasmType; mutable: boolean }
  );
  type WasmImport = WasmExport & { module: string };
  interface WasmModule { id: number; imports: WasmImport[]; exports: WasmExport[] }
  interface WasmTable { id: number; element: WasmElement }
  type WasmCall = { values: WasmValue[] } | { call: number; import: number; args: WasmValue[] };
  interface WasmNative {
    validate(bytes: Uint8Array): boolean;
    compile(bytes: Uint8Array): WasmModule;
    instantiate(id: number, bindings: (number | { kind: 'callback' | 'function'; id: number })[]): number;
    functionIdentity(id: number, name: string): WasmFunction;
    functionInfo(id: number): WasmFunction;
    call(id: number, args: WasmValue[]): WasmCall;
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
    memorySpan(id: number): { pointer: number; length: number; generation: bigint };
    growMemory(id: number, count: number): number;
    global(id: number, name: string, value?: WasmValue): WasmValue;
  }
  interface WasmInternal {
    native: { wasm: WasmNative; wasmMemoryBuffer(resource: number, previous: ArrayBuffer | undefined): ArrayBuffer };
    isWasmMemoryBuffer?: (value: unknown) => boolean;
  }
  interface Native { wasm: WasmNative }
}
