declare namespace BunWasm {
  type CommonJSWrapper = (...args: unknown[]) => unknown;
  interface ModuleCompileInternal {
    prepareText: Internal["prepareText"];
    native: { evalScript(source: string, filename: string, firstLine?: number): CommonJSWrapper };
  }
  interface Internal {
    require(name: "module_compile"): (content: string, filename: string) => CommonJSWrapper;
  }
}
