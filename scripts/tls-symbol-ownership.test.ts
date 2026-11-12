import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const glue = new URL("../crates/bunwasm-glue/", import.meta.url);

test("the shared BoringSSL owner supplies SSL session symbols on host and WASI", () => {
  const manifest = Bun.TOML.parse(readFileSync(new URL("Cargo.toml", glue), "utf8"));
  expect(manifest).toMatchObject({ dependencies: { "bunwasm-crypto-sys": { path: "../bunwasm-crypto-sys" } } });
  const support = readFileSync(new URL("src/extra.rs", glue), "utf8");
  expect(support).not.toContain("unreachable_c");
  for (const symbol of ["i2d_SSL_SESSION", "SSL_SESSION_up_ref", "SSL_SESSION_free"]) {
    expect(support).not.toContain(symbol);
  }
  const library = readFileSync(new URL("src/lib.rs", glue), "utf8");
  expect(library).toContain("extern crate bunwasm_crypto_sys;");
  expect(library).not.toMatch(/#\[cfg\(target_os = "wasi"\)\]\s*extern crate bunwasm_crypto_sys;/);
});
