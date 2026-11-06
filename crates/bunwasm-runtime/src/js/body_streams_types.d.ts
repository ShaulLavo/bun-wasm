declare namespace BunWasm {
  interface Internal {
    require(name: "body_streams"): {
      consume<T>(stream: ReadableStream<T>, visit: (chunk: T) => void): Promise<void>;
    };
  }
}
