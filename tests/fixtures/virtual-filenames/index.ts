import assert from "node:assert/strict";
import { Script } from "node:vm";

const names = [
  "ordinary.ts", "C:\\project\\file.ts", "日本語/🦀.ts", "%00",
  "\0plugin-vue:export-helper", "/home/user/\0plugin-vue:export-helper",
  "\0a\0b\0", "日本語\0🦀%00\\.ts",
];
const prepare = Error.prepareStackTrace;
try {
  for (const filename of names) {
    Error.prepareStackTrace = (_error, frames) => JSON.stringify(frames
      .filter(frame => frame.getFileName() === filename)
      .map(frame => ({ file: frame.getFileName(), line: frame.getLineNumber() })));
    const script = new Script("new Error('virtual filename')", { filename });
    const error: unknown = script.runInThisContext();
    assert(error instanceof Error);
    assert.equal(error.stack, JSON.stringify([{ file: filename, line: 1 }]));
    assert.equal(new Script("6 * 7", { filename }).runInThisContext(), 42);
  }
} finally {
  Error.prepareStackTrace = prepare;
}
console.log("virtual filenames preserve execution and source-map keys");
