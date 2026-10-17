declare namespace BunWasm {
  interface Internal {
    nextTick(callback: () => void): void;
  }
  interface GuestProcess extends NodeEmitter {
    connected?: boolean;
    channel?: { ref(): unknown; unref(): unknown } | null;
    send?: (...args: unknown[]) => boolean;
    disconnect?: () => void;
  }
}
