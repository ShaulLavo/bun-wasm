type MapPosition = (filename: string, line: number, column: number) => [number, number] | null | undefined;
const NativeString = String;

export function createScriptEvaluation(evaluate: (source: string, filename: string) => unknown, mapPosition: MapPosition) {
  const lineOffsets = new Map<string, number>();
  function evalScript(code: unknown, filename?: string, firstLine = 1) {
    const file = filename || "evalmachine.<anonymous>";
    if (firstLine === 1) lineOffsets.delete(file);
    else lineOffsets.set(file, firstLine - 1);
    return evaluate(NativeString(code), file);
  }
  return {
    evalScript,
    evalBuiltin: evalScript,
    mapPosition(filename: string, line: number, column: number): ReturnType<MapPosition> {
      const offset = lineOffsets.get(filename);
      return offset === undefined ? mapPosition(filename, line, column) : [line + offset, column];
    },
  };
}
