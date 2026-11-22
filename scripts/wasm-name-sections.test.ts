import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { needsRust } from "./ci-changes.ts";
import { assertNoNameSection, assertShippedGuestHasNoNames, hasNameSection, nameFreeGuests, stripNameSection } from "./wasm-name-sections.ts";

const header = [0, 97, 115, 109, 1, 0, 0, 0];
const text = (value: string) => Array.from(new TextEncoder().encode(value));
const custom = (name: string, payload: number[]) => {
  const body = [name.length, ...text(name), ...payload];
  return [0, body.length, ...body];
};
// One function type () -> (), one function, a function body, then debug and metadata sections.
const code = [
  1, 4, 1, 0x60, 0, 0,
  3, 2, 1, 0,
  10, 4, 1, 2, 0, 0x0b,
];
const named = Uint8Array.from(header.concat(code, custom("name", [1, 2, 3, 4, 5]), custom("producers", [0]), custom("name", [9])));
const plain = Uint8Array.from(header.concat(code, custom("producers", [0])));

test("detects a name section", () => {
  expect(WebAssembly.validate(named)).toBe(true);
  expect(hasNameSection(named)).toBe(true);
  expect(hasNameSection(plain)).toBe(false);
  expect(() => assertNoNameSection(named, "guest.wasm")).toThrow("guest.wasm carries a Wasm name section");
  expect(() => assertNoNameSection(plain, "guest.wasm")).not.toThrow();
});

test("stripping removes only name sections", () => {
  const stripped = stripNameSection(named);
  expect(Array.from(stripped)).toEqual(Array.from(plain));
  expect(WebAssembly.validate(stripped)).toBe(true);
  expect(Array.from(stripNameSection(plain))).toEqual(Array.from(plain));
});

test("a name that only starts like the section is not one", () => {
  const lookalike = Uint8Array.from(header.concat(code, custom("names", [1]), custom("nam", [1])));
  expect(hasNameSection(lookalike)).toBe(false);
  expect(Array.from(stripNameSection(lookalike))).toEqual(Array.from(lookalike));
});

test("malformed modules are rejected, not passed", () => {
  expect(() => hasNameSection(Uint8Array.from([1, 2, 3]))).toThrow("Wasm version 1");
  expect(() => hasNameSection(Uint8Array.from(header.concat([0, 50, 4])))).toThrow("Truncated");
  // A custom section whose name is not UTF-8 is invalid Wasm, so it must not pass as name free.
  expect(() => hasNameSection(Uint8Array.from(header.concat([0, 2, 1, 0xff])))).toThrow();
  // A five byte length with bits above 32 set is invalid.
  expect(() => hasNameSection(Uint8Array.from(header.concat([0, 0xff, 0xff, 0xff, 0xff, 0x1f])))).toThrow("Invalid Wasm integer");
});

test("the browser guest must be name free and other guests are not judged", () => {
  expect(nameFreeGuests).toContain("bun-browser.wasm");
  expect(() => assertShippedGuestHasNoNames("bun-browser.wasm", named)).toThrow("bun-browser.wasm carries a Wasm name section");
  expect(() => assertShippedGuestHasNoNames("bun-browser.wasm", plain)).not.toThrow();
  expect(() => assertShippedGuestHasNoNames("bun.wasm", named)).not.toThrow();
  expect(() => assertShippedGuestHasNoNames("bun-browser.wasm", named, true)).not.toThrow();
});

test("the build recipe ships the stripped guest and the shipping paths check it", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const recipe = source("./build-bun-browser.sh");
  const named = recipe.indexOf('-o "$root/dist/bun-browser.named.wasm"');
  const strip = recipe.indexOf('wasm-name-sections.ts" strip "$root/dist/bun-browser.named.wasm" "$root/dist/bun-browser.wasm"');
  const check = recipe.indexOf('wasm-name-sections.ts" check "$root/dist/bun-browser.wasm"');
  const receipt = recipe.indexOf('guest-build-receipt.ts" write "$root/dist/bun-browser.wasm"');
  expect(named).toBeGreaterThan(0);
  expect(strip).toBeGreaterThan(named);
  expect(check).toBeGreaterThan(strip);
  expect(receipt).toBeGreaterThan(check);
  for (const path of ["../web/build.ts", "../sandbox/build.ts", "./guest-acceptance.ts", "./ci-browser-program.ts", "./site-guest-preflight.ts"]) {
    expect(source(path)).toContain("assertShippedGuestHasNoNames(");
  }
});

test("the public site never sees the profiling override", () => {
  const site = readFileSync(new URL("../site/build.ts", import.meta.url), "utf8");
  const verified = site.indexOf("await verifySiteGuests(");
  const dropped = site.indexOf("delete process.env.BUN_WASM_KEEP_NAMES");
  const built = site.indexOf("await build(");
  expect(verified).toBeGreaterThan(0);
  expect(dropped).toBeGreaterThan(verified);
  expect(built).toBeGreaterThan(dropped);
});

test("a change to the stripper selects the guest build and browser coverage", () => {
  expect(needsRust(["scripts/wasm-name-sections.ts"])).toBe(true);
  expect(readFileSync(new URL("./browser-guest-selection.ts", import.meta.url), "utf8")).toContain('"scripts/wasm-name-sections.ts"');
});
