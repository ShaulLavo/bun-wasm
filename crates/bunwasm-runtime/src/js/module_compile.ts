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
    const source = content.replace(/^#![^\r\n\u2028\u2029]*/, "").replace(/^\uFEFF/, "");
    // Validate the body separately so it cannot close the enclosing wrapper and run during eval.
    try {
      new NativeFunction("exports", "require", "module", "__filename", "__dirname", source);
    } catch (error) {
      if (error instanceof SyntaxError) error.stack = `${filename}\n${error.stack}`;
      throw error;
    }
    return internal.native.evalScript(`(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n${source}\n})`, filename, -1);
  };
})
