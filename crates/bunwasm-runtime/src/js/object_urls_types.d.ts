declare namespace BunWasm {
  interface Internal {
    require(name: "object_urls"): {
      createObjectURL(blob: Blob): string;
      resolveObjectURL(input: unknown): Blob | undefined;
      revokeObjectURL(input: unknown): void;
    };
  }
}
