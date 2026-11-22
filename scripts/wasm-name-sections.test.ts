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

test("every shipped guest, core and side must be name free and other modules are not judged", () => {
  for (const guest of ["bun-browser.wasm", "bun.wasm", "quickjs.wasm", "bun-jsc.wasm", "jsc-engine.wasm", "bun-tools.wasm"]) {
    expect(nameFreeGuests).toContain(guest);
    expect(() => assertShippedGuestHasNoNames(guest, named)).toThrow(`${guest} carries a Wasm name section`);
    expect(() => assertShippedGuestHasNoNames(guest, plain)).not.toThrow();
    expect(() => assertShippedGuestHasNoNames(guest, named, true)).not.toThrow();
  }
  expect(() => assertShippedGuestHasNoNames("spidermonkey-engine.wasm", named)).not.toThrow();
});

test("every producer keeps a named copy and receipts the stripped module", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const recipes = [
    { path: "./build-bun-core.sh", named: '-o "$named"', strip: 'strip "$named" "$core"', receipt: 'guest-core-receipt.ts" write "$core"' },
    { path: "./build-engine-quickjs.sh", named: '"$out/engine.named.wasm" "${explicit_profile[@]}"', strip: 'strip "$out/engine.named.wasm" "$out/engine.wasm"', receipt: 'guest-engine-receipt.ts" write "$out/engine.wasm"' },
    { path: "./build-engine-jsc.sh", named: '"$named" "${explicit_profile[@]}"', strip: 'strip "$named" "$side"', receipt: 'guest-engine-receipt.ts" write "$side"' },
    { path: "./build-bun-tools.sh", named: '"$root/dist/bun-tools.named.wasm" "$CARGO_TARGET_DIR/tools-optimized"', strip: 'strip "$root/dist/bun-tools.named.wasm" "$root/dist/bun-tools.wasm"', receipt: 'guest-build-receipt.ts" write "$root/dist/bun-tools.wasm"' },
  ];
  for (const recipe of recipes) {
    const text = source(recipe.path);
    const named = text.indexOf(recipe.named), strip = text.indexOf(recipe.strip), receipt = text.indexOf(recipe.receipt);
    expect(named, recipe.path).toBeGreaterThan(0);
    expect(strip, recipe.path).toBeGreaterThan(named);
    expect(receipt, recipe.path).toBeGreaterThan(strip);
  }
  // The JSC interpreter frame check finds the interpreter by name, so it reads the named copy.
  expect(source("./build-engine-jsc.sh")).toContain('jsc-cloop-frame.ts" check "$named"');
  expect(source("./stage-program-profiles.ts")).toContain("assertShippedGuestHasNoNames(");
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
  for (const path of ["./stage-guest-wasm.ts", "./guest-acceptance.ts", "./ci-browser-program.ts", "./site-guest-preflight.ts"]) {
    expect(source(path)).toContain("assertShippedGuestHasNoNames(");
  }
  for (const path of ["../web/build.ts", "../sandbox/build.ts"]) expect(source(path)).toContain("stageGuestWasm(");
});

test("the public site never sees the profiling override", () => {
  const site = readFileSync(new URL("../site/build.ts", import.meta.url), "utf8");
  const verified = site.indexOf("await verifySiteGuests(");
  const dropped = site.indexOf('process.env.BUN_WASM_KEEP_NAMES = "0"');
  const built = site.indexOf("await build(");
  expect(verified).toBeGreaterThan(0);
  expect(dropped).toBeGreaterThan(verified);
  expect(built).toBeGreaterThan(dropped);
});

test("a change to the stripper selects the guest build and browser coverage", () => {
  expect(needsRust(["scripts/wasm-name-sections.ts"])).toBe(true);
  expect(readFileSync(new URL("./browser-guest-selection.ts", import.meta.url), "utf8")).toContain('"scripts/wasm-name-sections.ts"');
});
