interface SymbolConstructor { readonly asyncDispose: unique symbol }
declare namespace BunWasm {
  interface BufferConstructor {
    alloc(size: number): BufferBytes;
    concat(list: Uint8Array[]): BufferBytes;
  }
}
