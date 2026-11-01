import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseRootBundle, rootPin, verifyRootBundle } from "./tls-roots.ts";

const bundle = readFileSync(new URL("../crates/bunwasm-runtime/data/tls-roots.der", import.meta.url));
const source: unknown = JSON.parse(readFileSync(new URL("../crates/bunwasm-runtime/data/tls-roots.source.json", import.meta.url), "utf8"));

describe("pinned TLS roots", () => {
  test("fully parses all 121 CA certificates and verifies the pin", () => {
    const result = verifyRootBundle(bundle, source);
    expect(result).toMatchObject({ count: rootPin.count, bytes: rootPin.bytes, sha256: rootPin.sha256 });
    expect(result.sourceFiles).toHaveLength(5);
  });

  test("rejects truncated and unexpected headers", () => {
    for (const end of [0, 3, 7, 100, 490, bundle.length - 1]) expect(() => parseRootBundle(bundle.subarray(0, end))).toThrow();
    const wrongCount = Buffer.from(bundle);
    wrongCount.writeUInt32LE(120, 0);
    expect(() => parseRootBundle(wrongCount)).toThrow("count");
  });

  test("rejects overlapping, reversed, out-of-range and incomplete offsets", () => {
    for (const [offset, value] of [[4, 1], [8, 0], [8, 0xffffffff], [4 * 122, bundle.length]]) {
      const changed = Buffer.from(bundle);
      changed.writeUInt32LE(value!, offset!);
      expect(() => parseRootBundle(changed)).toThrow();
    }
  });

  test("rejects DER truncation, indefinite lengths and trailing bytes", () => {
    const header = 4 + 4 * 122;
    for (const [offset, value] of [[header, 0x31], [header + 1, 0x80], [header + 2, 0xff]]) {
      const changed = Buffer.from(bundle);
      changed[offset!] = value!;
      expect(() => parseRootBundle(changed)).toThrow();
    }
    const changed = Buffer.from(bundle);
    changed.writeUInt32LE(changed.readUInt32LE(8) + 1, 8);
    expect(() => parseRootBundle(changed)).toThrow();
  });

  test("rejects digest changes even when the certificates remain parseable", () => {
    const changed = Buffer.from(bundle);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() => verifyRootBundle(changed, source)).toThrow();
  });

  test("rejects unreviewed provenance and unsupported NSS release claims", () => {
    const changes: [string, unknown][] = [["commit", "0".repeat(40)], ["nssRelease", "unknown"], ["count", 120], ["license", {}]];
    for (const [key, value] of changes) {
      expect(() => verifyRootBundle(bundle, Object.assign({}, source, { [key]: value }))).toThrow();
    }
  });
});


test("native ALPN fixture uses the server selection callback", () => {
  const fixture = readFileSync(new URL("../crates/bunwasm-runtime/src/tls/tests.rs", import.meta.url), "utf8");
  expect(fixture).toContain("ffi::SSL_CTX_set_alpn_select_cb");
  expect(fixture).not.toContain("ffi::SSL_CTX_set_alpn_protos");
});

test("root slices share adjacent boundaries and reject offset backtracking", () => {
  const roots = parseRootBundle(bundle);
  for (let index = 1; index < roots.length; index++) {
    const previous = roots[index - 1]!;
    expect(roots[index]!.byteOffset).toBe(previous.byteOffset + previous.byteLength);
  }
  const changed = Buffer.from(bundle);
  changed.writeUInt32LE(0, 12);
  expect(() => parseRootBundle(changed)).toThrow();
});
