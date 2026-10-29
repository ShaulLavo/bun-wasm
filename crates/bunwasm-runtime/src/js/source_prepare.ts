(function (internal: BunWasm.Internal) {
  "use strict";
  type Prepared = BunWasm.PreparedSource;
  const native = internal.native;
  const hooks = native.engine === "host" && native.contextHooks;
  const version = native.engine === "host" ? native.prepareVersion : 4;
  const realm = `${process.pid}/${process.env?.BUNWASM_THREAD_ID || "0"}`;
  const budget = 16 * 1024 * 1024;
  const maxEntry = 4 * 1024 * 1024;
  const cache = new Map<string, { bytes: number; values: Prepared[] }>();
  const columns = new Map<string, Int32Array>();
  const counters = { prepared: 0, skippedByAbsence: 0, cacheHits: 0, fallbacks: 0, unhookedAwaitUsing: 0, spreadEval: 0 };
  let bytes = 0;
  let columnBytes = 0;
  const text = [
    "__bunwasm_resume(__bunwasm_capture(), ", ")", "__bunwasm_resumed(", "__bunwasm_id(",
    ", __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0)",
    "let __bunwasm_s = 0; ", "__bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); ",
    ", __bunwasm_s = __bunwasm_capture()), __bunwasm_s = 0)",
    "{ let __bunwasm_c; try { ", "__bunwasm_c = __bunwasm_iterate(",
    "try { __bunwasm_entered(__bunwasm_c); ",
    "} finally { __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); } ",
    " } finally { __bunwasm_exited(__bunwasm_c); } }", "{ try { __bunwasm_entered(__bunwasm_c); ",
    "} finally { __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); } }", "__bunwasm_evalArg(eval, ", "",
  ];
  function hasWork(source: string): boolean {
    return source.includes("await") || source.includes("eval") || source.includes("import");
  }
  function parseable(source: string): string {
    return source.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, value => value.length === 1 ? " " : value);
  }
  function remember(key: string, values: Prepared[]): void {
    const size = key.length * 2 + values.reduce((total, value) => total + (value.edits.length + value.columns.length) * 4, 0);
    if (size > maxEntry) return;
    cache.set(key, { bytes: size, values });
    bytes += size;
    while (bytes > budget) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      bytes -= cache.get(first)!.bytes;
      cache.delete(first);
    }
  }
  function records(payload: string, goal: string, load: () => Prepared[]): { values: Prepared[]; hit: boolean } {
    const key = `p${version}\0${realm}\0${goal}\0c1\0${payload}`;
    const previous = cache.get(key);
    if (previous) {
      cache.delete(key);
      cache.set(key, previous);
      counters.cacheHits++;
      return { values: previous.values, hit: true };
    }
    const values = load();
    if (values.some(value => value.version !== version)) throw new Error("source preparation version mismatch");
    remember(key, values);
    return { values, hit: false };
  }
  function sourceName(source: string, name?: string): string | undefined {
    const urls = Array.from(source.matchAll(/\/\/[#@]\s*sourceURL=([^\r\n\u2028\u2029]*)/g), match => match[1].trim());
    return urls.at(-1) || name;
  }
  function register(name: string | undefined, table: number[]): void {
    if (!name) return;
    const old = columns.get(name);
    columnBytes -= old?.byteLength ?? 0;
    columns.delete(name);
    const value = Int32Array.from(table);
    columns.set(name, value);
    columnBytes += value.byteLength;
    while (columnBytes > budget || columns.size > 4096) {
      const first = columns.keys().next().value;
      if (first === undefined) break;
      columnBytes -= columns.get(first)!.byteLength;
      columns.delete(first);
    }
  }
  function apply(source: string, value: Prepared, name?: string): string {
    const edits = value.edits;
    const table: number[] = [];
    let result = "";
    let previous = 0;
    let line = 1;
    let column = 1;
    const replacement = native.engine === "host"
      ? `__bunwasm_dynamicImport(${JSON.stringify(name || internal.mainPath)})`
      : `(function(){})["__bunwasmFunctionImport"](${JSON.stringify(name || internal.mainPath)})`;
    for (let index = 0; index < edits.length; index += 3) {
      const at = edits[index];
      const unchanged = source.slice(previous, at);
      const lines = unchanged.split(/\r\n|[\n\r\u2028\u2029]/);
      line += lines.length - 1;
      column = lines.length === 1 ? column + unchanged.length : lines.at(-1)!.length + 1;
      const inserted = edits[index + 2] === 16 ? replacement : text[edits[index + 2]];
      table.push(line, column, inserted.length - edits[index + 1]);
      result += unchanged + inserted;
      column += inserted.length;
      previous = at + edits[index + 1];
    }
    register(sourceName(source, name), table);
    return result + source.slice(previous);
  }
  function trace(origin: string, name: string | undefined, size: number, prepared: Prepared[], hit: boolean, start: number): void {
    counters.prepared++;
    counters.fallbacks += prepared.filter(value => value.fallback !== null).length;
    counters.spreadEval += prepared.reduce((total, value) => total + value.spreadEval, 0);
    counters.unhookedAwaitUsing += prepared.reduce((total, value) => total + value.unhookedAwaitUsing, 0);
    if (process.env?.BUN_WASM_PREPARE_TRACE !== "1") return;
    console.error("BUNWASM_PREPARE " + JSON.stringify({ version, realm, mapPolicy: "c1", origin, name, bytes: size * 2,
      edits: prepared.reduce((total, value) => total + value.edits.length / 3, 0), milliseconds: performance.now() - start,
      cacheHit: hit, fallback: prepared.map(value => value.fallback) }));
  }
  function prepareText(source: string, goal: BunWasm.PrepareGoal, origin: string, name?: string): string {
    if (!hooks) return source;
    if (!hasWork(source)) { counters.skippedByAbsence++; return source; }
    const start = performance.now();
    const prepared = records(source, goal, () => [JSON.parse(native.prepareSource(parseable(source), goal))]);
    trace(origin, name, source.length, prepared.values, prepared.hit, start);
    return apply(source, prepared.values[0], name);
  }
  function prepareFunctionArgs(args: string[], kind: BunWasm.FunctionKind, name?: string): string[] {
    if (!args.some(value => hooks ? hasWork(value) : value.includes("import"))) return args;
    const start = performance.now();
    const goal = `function:${kind}:${args.map(value => value.length).join(",")}:${hooks ? "hooks" : "imports"}`;
    const prepared = records(args.join(""), goal, () => JSON.parse(native.prepareFunction(args.map(parseable), kind, hooks)));
    trace(kind === "normal" ? "function" : `${kind}-function`, name, args.join("").length, prepared.values, prepared.hit, start);
    return args.map((source, index) => apply(source, prepared.values[index], index === args.length - 1 ? name : undefined));
  }
  function correctPosition(name: string, line: number, column: number): number {
    const table = columns.get(name);
    if (!table) return column;
    let correction = 0;
    for (let index = 0; index < table.length; index += 3) {
      if (table[index] !== line || table[index + 1] >= column) continue;
      correction += Math.min(table[index + 2], column - table[index + 1]);
    }
    return column - correction;
  }
  internal.prepareText = prepareText;
  internal.prepareFunctionArgs = prepareFunctionArgs;
  internal.preparedColumns = columns;
  internal.preparation = { counters, version, realm, correctPosition, cacheBytes: () => bytes, columnBytes: () => columnBytes };
  if (hooks) {
    const NativeEval = eval;
    internal.defineGlobal("__bunwasm_evalArg", (callee: unknown, source: unknown) =>
      callee === NativeEval && typeof source === "string" ? prepareText(source, "eval", "eval-direct") : source);
  } else if (native.engine === "host") internal.defineGlobal("__bunwasm_evalArg", (_callee: unknown, source: unknown) => source);
  return { prepareText, prepareFunctionArgs };
})
