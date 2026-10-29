type MapPosition = (filename: string, line: number, column: number) => [number, number] | null | undefined;
const NativeString = String;

export function createScriptEvaluation(evaluate: (source: string, filename: string) => unknown, mapPosition: MapPosition) {
  const lineOffsets = new Map<string, number>();
  const preparedColumns = new Map<string, { version: number; columns: Int32Array }>();
  function correctPreparedColumn(filename: string, line: number, column: number): number {
    const table = preparedColumns.get(filename)?.columns;
    if (!table) return column;
    let correction = 0;
    for (let index = 0; index < table.length; index += 3) {
      if (table[index] !== line || table[index + 1]! >= column) continue;
      correction += Math.min(table[index + 2]!, column - table[index + 1]!);
    }
    return column - correction;
  }
  return {
    preparedColumns,
    correctPreparedColumn,
    evalScript(code: unknown, filename?: string, firstLine = 1) {
      const file = filename || "evalmachine.<anonymous>";
      if (firstLine === 1) lineOffsets.delete(file);
      else lineOffsets.set(file, firstLine - 1);
      return evaluate(NativeString(code), file);
    },
    mapPosition(filename: string, line: number, column: number): ReturnType<MapPosition> {
      const corrected = correctPreparedColumn(filename, line, column);
      const offset = lineOffsets.get(filename);
      if (offset !== undefined) return [line + offset, corrected];
      const mapped = mapPosition(filename, line, corrected);
      return mapped ?? (corrected === column ? mapped : [line, corrected]);
    },
  };
}
