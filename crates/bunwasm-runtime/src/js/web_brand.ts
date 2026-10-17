(function () {
  return function brandInterfaces(interfaces: Record<string, { prototype: object }>) {
    for (const [name, constructor] of Object.entries(interfaces)) {
      Object.defineProperty(constructor.prototype, Symbol.toStringTag, { value: name, configurable: true });
    }
  };
})
