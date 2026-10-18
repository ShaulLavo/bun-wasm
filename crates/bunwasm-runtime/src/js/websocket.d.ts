// The preview bundler exports the classic-script factory without changing its body.
interface ByteConnection {
  closed: boolean;
  readonly bufferedAmount: number;
  onData: ((bytes: Uint8Array) => void) | null;
  onEnd: (() => void) | null;
  onClose: (() => void) | null;
  onError: ((error: Error) => void) | null;
  write(bytes: Uint8Array): void;
  startReading(): void;
  end(): void;
  destroy(): void;
}
interface WebsocketFactoryInputs {
  require(name: "buffer"): {
    Buffer: { from(input: string | ArrayBuffer | ArrayLike<number>): Uint8Array & { toString(encoding: string): string } };
  };
  builtin(name: "node:crypto"): {
    createHash(algorithm: string): { update(input: string): { digest(encoding: string): string | undefined } };
  };
  concatBytes(chunks: Uint8Array[]): Uint8Array;
  toUint8(input: ArrayBuffer | ArrayBufferView): Uint8Array;
  native: { hostConnect(host: string, port: number, tls?: boolean): number };
}
declare function websocketFactory(internal: WebsocketFactoryInputs): {
  clientClass(connection: new (handle: number) => ByteConnection): typeof WebSocket;
};
export default websocketFactory;
