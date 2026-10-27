declare namespace BunWasm {
  interface NetPort {
    error<T extends Error>(Ctor: new(message: string) => T, code: string, message: string): T & { code: string };
    port(value?: unknown): number;
    httpPort(value: unknown): number;
  }
  interface Internal {
    require(name: "net_port"): NetPort;
  }
}
