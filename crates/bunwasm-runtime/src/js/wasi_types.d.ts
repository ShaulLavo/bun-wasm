declare namespace BunWasm {
  interface Internal {
    require(name: "node_fs"): { fs: { constants: Readonly<Record<string, number>> } };
  }
}
