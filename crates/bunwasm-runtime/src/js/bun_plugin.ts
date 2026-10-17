(function (internal: BunWasm.Internal) {
  type ObjectModule = { loader: "object"; exports: object };
  type ModuleFactory = () => ObjectModule;
  type Builder = { module(name: string, factory: ModuleFactory): void };
  type Plugin = { name: string; setup(builder: Builder): unknown };

  const modules = new Set<string>();

  function register(name: string, factory: ModuleFactory) {
    if (typeof name !== "string" || !name) throw new TypeError("module name must be a non-empty string");
    if (typeof factory !== "function") throw new TypeError("module factory must be a function");
    const key = internal.native.registerObjectModule(name);
    internal.builtinFactories[key] = () => {
      const result = factory();
      if (!result || result.loader !== "object" || !result.exports || typeof result.exports !== "object") {
        throw new TypeError("Runtime module plugins require loader: 'object' and an exports object");
      }
      return result.exports;
    };
    modules.add(key);
  }

  function plugin(config: Plugin) {
    if (!config || typeof config.name !== "string" || typeof config.setup !== "function") {
      throw new TypeError("plugin requires a name and a setup function");
    }
    const result = config.setup({ module: register });
    if (result !== null && typeof result === "object" && "then" in result) {
      throw new TypeError("Runtime module plugin setup must be synchronous");
    }
  }

  plugin.clearAll = () => {
    for (const key of modules) delete internal.builtinFactories[key];
    modules.clear();
    internal.native.clearObjectModules();
  };

  return { plugin };
})
