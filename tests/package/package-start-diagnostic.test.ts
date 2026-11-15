import { expect, test } from "bun:test";
import { ProcessError } from "waffle/proc/types";
import { describeStartError, diagnosticBytes, diagnosticText } from "../../src/package-start-diagnostic.js";
import * as released from "../../node_modules/waffle/proc/start-diagnostic.ts";

test("reservation diagnostics match the released bounded encoder", () => {
  const circular = new Error("cycle");
  circular.cause = circular;
  const throwing = Object.defineProperty({}, "message", { get() { throw new Error("getter"); } });
  for (const cause of [undefined, circular, throwing, "\uFEFF" + "🙂".repeat(2000)]) {
    const error = new ProcessError(8, "missing inherited descriptor", { cause });
    expect(describeStartError(error)).toBe(released.describeStartError(error));
    expect(diagnosticText(diagnosticBytes(describeStartError(error)))).toBe(released.diagnosticText(released.diagnosticBytes(released.describeStartError(error))));
  }
  const text = "\uFEFF" + "🙂".repeat(2000);
  expect(diagnosticText(diagnosticBytes(text))).toBe(released.diagnosticText(released.diagnosticBytes(text)));
});
