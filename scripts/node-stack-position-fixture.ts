import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export type StackSite = {
  getScriptNameOrSourceURL(): string;
  getFileName(): string;
  getFunctionName(): string;
  getFunction(): () => void;
  getLineNumber(): number;
  getColumnNumber(): number;
  isNative(): boolean;
};

export function stackFormatter(native: object) {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = source.indexOf("  function isErrorConstructor(fn)");
  const end = source.indexOf("  // --- small path helpers", start);
  assert.ok(start > 0 && end > start, "production stack region exists");
  const factory: unknown = runInNewContext(`(function(native) { const internal = { getSourceLine: native.getSourceLine }; ${source.slice(start, end)}; return internal; })`);
  assert.ok(typeof factory === "function");
  const internal: unknown = factory(native);
  assert.ok(internal && typeof internal === "object" && "formatCallSite" in internal && typeof internal.formatCallSite === "function");
  const format = internal.formatCallSite;
  return { internal, format(site: StackSite): unknown { return format(site); } };
}

export function stackSite(column: number, line = 1): StackSite {
  return {
    getScriptNameOrSourceURL: () => "/huge.cjs", getFileName: () => "/huge.cjs", getFunctionName: () => "caller",
    getFunction: () => function caller() {}, getLineNumber: () => line, getColumnNumber: () => column, isNative: () => false,
  };
}

export function nativeStackProbe(): string {
  const root = new URL("../crates/bunwasm-runtime/src/", import.meta.url);
  const modules = readFileSync(new URL("modules.rs", root), "utf8");
  const natives = readFileSync(new URL("natives.rs", root), "utf8");
  const engine = readFileSync(new URL("engine.rs", root), "utf8");
  const host = readFileSync(new URL("engine_host.rs", root), "utf8");
  const section = (source: string, start: string, end: string) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `production region ${start} exists`);
    return source.slice(first, last);
  };
  const nativeStart = natives.lastIndexOf("    let st = state.clone();", natives.indexOf('t.add("mapPosition"'));
  assert.ok(nativeStart > 0);
  return readFileSync(new URL("../tests/fixtures/stack-source-position/native-probe.rs", import.meta.url), "utf8")
    .replace("__PLAIN_VALUES__", section(engine, "#[derive(Clone, Debug, PartialEq)]\npub enum Val", "/// Builds a `Val::Object`"))
    .replace("__WIRE_ENCODER__", section(host, "const T_UNDEFINED:", "struct Reader<'a>"))
    .replace("__STACK_PATH__", new URL("stack_position.rs", root).pathname)
    .replace("__MAP_PATH__", new URL("sourcemap.rs", root).pathname)
    .replace("__POSITION_MAP__", section(modules, "#[derive(Default)]\npub struct PositionMap", "/// What kind of module"))
    .replace("__SOURCE_METHODS__", section(modules, "    pub fn source_line(", "    /// Remember that `lines`"))
    .replace("__NATIVE_BODY__", natives.slice(nativeStart, natives.indexOf("    // `Bun.build`", nativeStart)))
    .replace("__NATIVE_TEST__", section(natives, "    #[test]\n    fn stack_column_native_", "    #[test]\n    fn real_descriptors_"));
}
