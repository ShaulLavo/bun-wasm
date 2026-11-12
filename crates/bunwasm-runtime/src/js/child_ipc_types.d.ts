declare namespace BunWasm {
  interface IpcDescriptors { input: number; output: number }
  interface ChildIpc {
    readonly connected: boolean;
    send(message: unknown, handle?: unknown, options?: unknown, callback?: unknown): boolean;
    disconnect(): void;
    /** Reads what the child left, then ends the channel as `end` does. */
    finish(): void;
    close(error?: Error): void;
    /** Closes as the channel's own terminal event, its disconnect in the channel's frame (the child's exit). */
    end(error?: Error): void;
    ref(): ChildIpc;
    unref(): ChildIpc;
  }
  interface Internal {
    require(name: "child_ipc"): { open(target: NodeEmitter, descriptors: IpcDescriptors, childSide?: boolean): ChildIpc; initialize(): void };
    nextTick(callback: () => unknown): void;
    concatBytes(chunks: Uint8Array[]): Uint8Array;
  }
  interface GuestProcess extends NodeEmitter {}
}
