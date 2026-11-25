import { copy, type DemoId } from "./showcase-copy";

/** One-click Bun API demos in the examples workspace. Each opens `file` and runs it. */
export type Demo = {
  readonly id: DemoId;
  readonly label: string;
  readonly title: string;
  /** The file the demo opens and runs. */
  readonly file: string;
  /** Example files it needs; missing ones are restored from the examples before it runs. */
  readonly files: readonly string[];
};

const files: Record<DemoId, readonly string[]> = {
  serve: ["serve.ts"],
  sqlite: ["sqlite.ts"],
  test: ["math.test.ts", "math.ts"],
  build: ["build.ts", "jsx.tsx", "math.ts"],
  shell: ["shell.ts"],
  file: ["bun-file.ts"],
};

export const demos: readonly Demo[] = Object.entries(files).map(([id, needed]) => ({
  id: id as DemoId,
  ...copy.demos[id as DemoId],
  file: needed[0]!,
  files: needed,
}));

export function demo(value: string | null): Demo | undefined {
  return demos.find(entry => entry.id === value);
}
