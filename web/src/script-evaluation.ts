type MapPosition = (filename: string, line: number, column: number) => [number, number] | null | undefined;
type Columns = { version: number; columns: Int32Array };
type GeneratedSource = Columns & { name: string; origin: string };
const NativeString = String;
const generatedMarker = "#bunwasm-prepared=c1/";

function isColumn(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
}

function generatedSource(filename: unknown): GeneratedSource | undefined {
  if (typeof filename !== "string") return;
  const marker = filename.lastIndexOf(generatedMarker);
  if (marker < 0) return;
  const payload = filename.indexOf("/", marker + generatedMarker.length);
  if (payload < 0) return;
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(filename.slice(payload + 1)));
  } catch {
    return;
  }
  if (!Array.isArray(value) || value.length !== 4) return;
  const [version, name, origin, columns] = value;
  if (!isColumn(version) || typeof name !== "string" || typeof origin !== "string" || !Array.isArray(columns)) return;
  if (columns.length % 3 !== 0 || !columns.every(isColumn)) return;
  return { version, name, origin, columns: Int32Array.from(columns) };
}

export function createScriptEvaluation(evaluate: (source: string, filename: string) => unknown, mapPosition: MapPosition) {
  const lineOffsets = new Map<string, number>();
  const preparedColumns = new Map<string, Columns>();
  let generatedSequence = 0;
  // The engine keeps this metadata with its code; a live function never depends on cache retention.
  function preparedSourceURL(version: number, name: string, columns: readonly number[], origin: string): string {
    const payload = encodeURIComponent(JSON.stringify([version, name, origin, columns]));
    return `${name}${generatedMarker}${++generatedSequence}/${payload}`;
  }
  function preparedSourceName(filename: unknown): string | undefined {
    return generatedSource(filename)?.name;
  }
  function preparedSourceOrigin(filename: unknown): string | undefined {
    return generatedSource(filename)?.origin;
  }
  function correctPreparedColumn(filename: string, line: number, column: number): number {
    const table = generatedSource(filename)?.columns ?? preparedColumns.get(filename)?.columns;
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
    preparedSourceURL,
    preparedSourceName,
    preparedSourceOrigin,
    correctPreparedColumn,
    evalScript(code: unknown, filename?: string, firstLine = 1) {
      const file = filename || "evalmachine.<anonymous>";
      if (firstLine === 1) lineOffsets.delete(file);
      else lineOffsets.set(file, firstLine - 1);
      return evaluate(NativeString(code), file);
    },
    mapPosition(filename: string, line: number, column: number): ReturnType<MapPosition> {
      const corrected = correctPreparedColumn(filename, line, column);
      if (generatedSource(filename)) return [line, corrected];
      const offset = lineOffsets.get(filename);
      if (offset !== undefined) return [line + offset, corrected];
      const mapped = mapPosition(filename, line, corrected);
      return mapped ?? (corrected === column ? mapped : [line, corrected]);
    },
  };
}
