declare namespace BunWasm {
  type WebSocketBinaryType = "blob" | "nodebuffer" | "arraybuffer" | "uint8array";
  type WebSocketReadyState = 0 | 1 | 2 | 3;
  type WebSocketData = string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView;
  type WebSocketMessage = string | Uint8Array | ArrayBuffer;
  interface WebSocketCloseInfo { code: number; reason: string; clean: boolean }
  interface WebSocketFrame { fin: boolean; opcode: number; bytes: Uint8Array; length: number }
  interface WebSocketSendItem { bytes: Uint8Array | Blob; size: number; opcode: number }
  interface WebSocketHooks {
    message(data: WebSocketMessage): void;
    error?(error: Error): void;
    ping?(data: Uint8Array): void;
    pong?(data: Uint8Array): void;
    close?(info: WebSocketCloseInfo): void;
  }
  interface WebSocketConnection {
    closed: boolean;
    readonly bufferedAmount: number;
    onData: ((bytes: Uint8Array) => void) | null;
    onEnd: (() => void) | null;
    onError: ((error: Error) => void) | null;
    onClose: (() => void) | null;
    write(bytes: Uint8Array): void;
    startReading(): void;
    end(): void;
    destroy(): void;
  }
  interface WebSocketServerConnection extends WebSocketConnection {
    onDrain: (() => void) | null;
    peer(): { address: string };
  }
  interface WebSocketServerSocket {
    data: unknown;
    binaryType: WebSocketBinaryType;
    remoteAddress: string;
    readonly readyState: WebSocketReadyState;
    readonly subscriptions: string[];
    readonly bufferedAmount: number;
    send(data: WebSocketData): number;
    sendText(data: unknown): number;
    sendBinary(data: WebSocketData): number;
    ping(data?: WebSocketData): number;
    pong(data?: WebSocketData): number;
    close(code?: number, reason?: string): void;
    terminate(): void;
    subscribe(topic: unknown): boolean;
    unsubscribe(topic: unknown): boolean;
    isSubscribed(topic: unknown): boolean;
    publish(topic: unknown, data: WebSocketData): number;
    publishText(topic: unknown, data: unknown): number;
    publishBinary(topic: unknown, data: WebSocketData): number;
    cork(callback: () => void): void;
    getBufferedAmount(): number;
  }
  type WebSocketPublish = (topic: string, data: WebSocketData, exclude: WebSocketServerSocket | null) => number;
  interface WebSocketHandlerArgs {
    open: [];
    message: [data: WebSocketMessage];
    ping: [data: Uint8Array];
    pong: [data: Uint8Array];
    error: [error: unknown];
    close: [code: number, reason: string];
    drain: [];
  }
  type WebSocketHandler<K extends keyof WebSocketHandlerArgs> = (socket: WebSocketServerSocket, ...args: WebSocketHandlerArgs[K]) => void | Promise<unknown>;
  type WebSocketHandlers = {
    [K in keyof WebSocketHandlerArgs]?: WebSocketHandler<K>;
  } & { maxPayloadLength?: number; publishToSelf?: boolean };
  interface WebSocketClientOptions {
    protocols?: string | string[];
    headers?: HeadersInit;
    proxy?: unknown;
    tls?: unknown;
  }
  interface Native { hostConnect(host: string, port: number): number }
  interface WebSocketInternal {
    require: Internal["require"];
    builtin(name: "node:crypto"): { createHash(algorithm: "sha1"): { update(input: string): { digest(encoding: "base64"): string } } };
    concatBytes: Internal["concatBytes"];
    toUint8: Internal["toUint8"];
    native: Pick<Native, "hostConnect">;
    printError(error: unknown): void;
  }
}
