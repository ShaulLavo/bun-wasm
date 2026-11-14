export function ciExpression(source: string, values: Record<string, unknown>): unknown {
  const expression = source.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/(?:github|needs|vars|runner|steps|inputs)\.[\w.-]+/g, name => {
      if (!(name in values)) throw new Error(`Missing CI expression value: ${name}`);
      return JSON.stringify(values[name]);
    });
  return new Function("fromJSON", `return (${expression})`)(JSON.parse);
}

export function ciRunner(source: unknown, values: Record<string, unknown> = {}): unknown {
  if (typeof source !== "string") throw new Error("Expected CI runner expression");
  if (!source.startsWith("${{")) return [source];
  return ciExpression(source, {
    "vars.BUN_WASM_PC_RUNNER": "",
    "github.event_name": "pull_request",
    "github.ref": "refs/pull/1/merge",
    "github.repository": "ShaulLavo/bun-wasm",
    "github.event.pull_request.head.repo.full_name": "ShaulLavo/bun-wasm",
    ...values,
  });
}
