declare namespace BunWasm {
  type WasmWire = number | bigint | null;
  interface WasmSignature { params: string[]; results: string[]; }
  type WasmExport = { name: string } & (
    { kind: "function"; params: string[]; results: string[] } |
    { kind: "table"; type: string } |
    { kind: "global"; type: string; mutable: boolean } |
    { kind: "memory" }
  );
  type WasmImport = WasmExport & { module: string };
  interface WasmDescription { id: number; imports: WasmImport[]; exports: WasmExport[]; }
  type WasmImportCall = { import: number; args: WasmWire[] } & ({ call: number } | { direct: true });
  type WasmCall = { values: WasmWire[] } | WasmImportCall;
  interface Native {
    wasm: {
      compile(source: Uint8Array): WasmDescription;
      validate(source: Uint8Array): boolean;
      instantiate(id: number, imports: (number | number[])[]): number;
      function(id: number, name: string): number;
      functionType(id: number): WasmSignature;
      call(id: number, args: WasmWire[]): WasmCall;
      resume(id: number, args: WasmWire[]): WasmCall;
      cancel(id: number): void;
      read(id: number, name: string): { bytes: Uint8Array; generation: bigint };
      memoryIdentity(id: number, name: string): number;
      write(id: number, name: string, bytes: Uint8Array): void;
      grow(id: number, name: string, pages: number): number;
      global(id: number, name: string, value?: WasmWire): WasmWire;
      table(id: number, name: string): number;
      tableNew(type: string, minimum: number, maximum: number | undefined, init: WasmWire): number;
      tableSize(id: number): number;
      tableGet(id: number, index: number): WasmWire;
      tableSet(id: number, index: number, value: WasmWire): void;
      tableGrow(id: number, delta: number, value: WasmWire): number;
    };
  }
}
