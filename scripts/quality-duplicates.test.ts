import { expect, test } from "bun:test";
import {
  buildJscpdArgs,
  compareAllowances,
  parseBaseline,
  parseComparisonBaseline,
  resolveBaseRef,
} from "./quality-duplicates";

const first = "0123456789abcdef";
const second = "fedcba9876543210";
const added = "1111111111111111";

function value(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    fingerprints: { [first]: 1, [second]: 2 },
    reasons: { [first]: "first reason", [second]: "second reason" },
    ...overrides,
  };
}

test.each([
  ["missing fingerprint map", { fingerprints: undefined }, "fingerprints"],
  ["null fingerprint map", { fingerprints: null }, "fingerprints"],
  ["array fingerprint map", { fingerprints: [] }, "fingerprints"],
  ["missing reason", { reasons: { [first]: "first reason" } }, "missing a reason"],
  ["empty reason", { reasons: { [first]: "", [second]: "second reason" } }, "trimmed"],
  ["whitespace-only reason", { reasons: { [first]: "   ", [second]: "second reason" } }, "trimmed"],
  ["multiline reason", { reasons: { [first]: "first\nreason", [second]: "second reason" } }, "single-line"],
  ["Unicode line separator reason", { reasons: { [first]: "first\u2028reason", [second]: "second reason" } }, "single-line"],
  ["Unicode paragraph separator reason", { reasons: { [first]: "first\u2029reason", [second]: "second reason" } }, "single-line"],
  ["non-string reason", { reasons: { [first]: 1, [second]: "second reason" } }, "trimmed"],
  ["orphan reason", { reasons: { [first]: "first reason", [second]: "second reason", [added]: "orphan" } }, "orphan"],
  ["wrong version", { version: 2 }, "version"],
  ["malformed fingerprint", { fingerprints: { bad: 1 }, reasons: { bad: "reason" } }, "malformed"],
  ["zero count", { fingerprints: { [first]: 0 }, reasons: { [first]: "reason" } }, "positive"],
  ["negative count", { fingerprints: { [first]: -1 }, reasons: { [first]: "reason" } }, "positive"],
  ["fractional count", { fingerprints: { [first]: 1.5 }, reasons: { [first]: "reason" } }, "positive"],
  ["unsafe count", { fingerprints: { [first]: Number.MAX_SAFE_INTEGER + 1 }, reasons: { [first]: "reason" } }, "positive"],
] as const)("rejects %s", (_name, input, message) => {
  expect(() => parseBaseline(value(input))).toThrow(message);
});

test("rejects a non-object reasons map", () => {
  expect(() => parseBaseline(value({ reasons: null }))).toThrow("reasons");
  expect(() => parseBaseline(value({ reasons: [] }))).toThrow("reasons");
});

test("accepts unchanged keys and counts with reasons", () => {
  const parsed = parseBaseline(value());
  expect(parsed.fingerprints).toEqual({ [first]: 1, [second]: 2 });
  expect(parsed.reasons).toEqual({ [first]: "first reason", [second]: "second reason" });
});

test("allows deleting a key and lowering a count", () => {
  const base = parseComparisonBaseline({ version: 1, fingerprints: { [first]: 1, [second]: 2 } });
  compareAllowances({ [first]: 1 }, base.fingerprints);
  compareAllowances({ [first]: 1, [second]: 1 }, base.fingerprints);
});

test.each([
  ["raising a count", { [first]: 2 }, "increases"],
  ["adding a key", { [first]: 1, [second]: 2, [added]: 1 }, "adds allowance"],
  ["replacing a key", { [first]: 1, [added]: 2 }, "adds allowance"],
])("rejects %s", (_name, current, message) => {
  expect(() => compareAllowances(current, { [first]: 1, [second]: 2 })).toThrow(message);
});

test("reason-only changes do not affect numeric comparison", () => {
  const current = parseBaseline(value({ reasons: { [first]: "changed", [second]: "also changed" } }));
  const base = parseComparisonBaseline({ version: 1, fingerprints: { [first]: 1, [second]: 2 } });
  compareAllowances(current.fingerprints, base.fingerprints);
});

test("historical reasonless baseline is comparison input only", () => {
  const historical = parseComparisonBaseline({ version: 1, fingerprints: { [first]: 1 } });
  expect(historical.fingerprints).toEqual({ [first]: 1 });
  expect(() => parseBaseline({ version: 1, fingerprints: { [first]: 1 } })).toThrow("reasons");
});

test("comparison refs fail when missing or unresolvable", () => {
  expect(() => resolveBaseRef(process.cwd(), { JSCPD_BASE_REF: "" })).toThrow("Missing JSCPD_BASE_REF");
  expect(() => resolveBaseRef(process.cwd(), { JSCPD_BASE_REF: "f".repeat(40) })).toThrow("Missing commit object");
});

test("command builder preserves native flags and only forwards ast kind", () => {
  expect(buildJscpdArgs([])).toEqual([
    "--config",
    ".jscpd.json",
    "--baseline",
    ".jscpd-baseline.json",
    "--fail-on-new-clones",
    "0",
    "--fail-on-empty",
  ]);
  expect(buildJscpdArgs(["--kind", "ast"])).toContain("--kind");
  expect(() => buildJscpdArgs(["--kind", "ast", "--update-baseline"])).toThrow("Usage");
  expect(() => buildJscpdArgs(["--update-baseline"])).toThrow("Usage");
  expect(() => buildJscpdArgs(["--baseline", "other.json"])).toThrow("Usage");
  expect(() => buildJscpdArgs(["--config", "other.json"])).toThrow("Usage");
  expect(() => buildJscpdArgs(["--output", "other.json"])).toThrow("Usage");
  expect(() => buildJscpdArgs(["--kind", "exact"])).toThrow("Usage");
});
