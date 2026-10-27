export function comparableLifecycle(rows: [string, unknown][]) {
  return rows.map(([name, value]) => {
    if (name !== "promise-chunk" && name !== "thenable-chunk") return [name, value];
    if (value === null || typeof value !== "object" || !("error" in value)) throw new Error(`Missing ${name} TypeError`);
    if (typeof value.error !== "string" || !value.error.startsWith("TypeError:")) throw new Error(`Wrong ${name} error`);
    return [name, Object.assign({}, value, { error: "TypeError" })];
  });
}
