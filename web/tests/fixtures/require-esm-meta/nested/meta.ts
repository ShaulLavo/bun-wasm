const $Bun_import_meta = "local";
const $Bun_import_\u006deta$1 = "escaped";
export function inspect() {
  const meta = import.meta;
  return [meta === import.meta, meta.resolve("./payload.cts"), meta.url, meta.path,
    meta.dirname, meta.filename, meta.main, meta.require("./payload.cts"),
    $Bun_import_meta, $Bun_import_meta$1, "import.meta", /import\.meta/.test("import.meta")].join("|");
}
