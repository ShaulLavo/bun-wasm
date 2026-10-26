(function (internal: BunWasm.ModuleCompileInternal) {
  "use strict";
  const NativeFunction = Function;

  function requireString(value: unknown, name: string): asserts value is string {
    if (typeof value === "string") return;
    throw Object.assign(new TypeError(`The "${name}" argument must be of type string.`), { code: "ERR_INVALID_ARG_TYPE" });
  }

  return function compile(content: string, filename: string): BunWasm.CommonJSWrapper {
    requireString(content, "content");
    requireString(filename, "filename");
    const source = content.replace(/^#![^\r\n]*/, "").replace(/^\uFEFF/, "");
    // Validate the body separately so it cannot close the enclosing wrapper and run during eval.
    new NativeFunction("exports", "require", "module", "__filename", "__dirname", source);
    return internal.native.evalScript(`(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n${source}\n})`, filename);
  };
})
