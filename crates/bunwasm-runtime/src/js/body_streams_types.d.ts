declare namespace BunWasm {
  interface Internal {
    require(name: "body_streams"): {
      values<T>(stream: ReadableStream<T>): AsyncIterableIterator<T>;
    };
  }
}
