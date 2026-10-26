declare namespace BunWasm {
  type CommonJSWrapper = (...args: unknown[]) => unknown;
  interface ModuleCompileInternal {
    native: { evalScript(source: string, filename: string): CommonJSWrapper };
  }
  interface Internal {
    require(name: "module_compile"): (content: string, filename: string) => CommonJSWrapper;
  }
}
