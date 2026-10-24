## Audit method

The inventory comes from `patches/bun/*.patch` and tracked files under `crates/`, `web/`, `sandbox/`, `scripts/`, `jsc/`, `site/`, and `third_party/`. The copied-source pass reads provenance headers, license notices, declared translations, generated-source inputs, and source-write operations. It also compares nontrivial implementation lines and token sequences against Bun's sources, then checks candidates against the exact Bun pin with `git show <pin>:<path>`. Direct Node comparisons use the exact reference revision above. Literal matching alone misses translated ports such as cookies, console formatting, and string decoding.

The sweep includes browser WASI/FS/network/engine bridges, sandbox cache/editor wiring, script runners, JSC FFI declarations and C++ helpers, and build-time shims. These are original adapters, configuration, or API declarations except for the entries explicitly listed above. Shared calendar names, public field layouts, and ordinary API-call boilerplate do not establish copied implementations. For example, the PerformanceEntry field assignments in `web.js` match a public data shape, and the JSC loader callbacks use the engine's required signatures. They are not classified as upstream forks on that basis.

The inventory and marker search can be repeated from the repository root. Marker hits are review candidates, not an automatic proof of copying.

```sh
git ls-files crates web sandbox scripts jsc site third_party
rg -n -i --max-columns 240 'copyright|license|ported|port of|adapted|copied|derived|based on' crates web sandbox scripts jsc site
```

Retained libc and rquickjs-sys files were compared byte-for-byte with the matching published crates in Cargo's registry. The `vendor/bun` working tree must be clean after applying all ten commits. There are no additional unexported Bun source modifications in the audited checkout.

SQLite is supplied by the unmodified `libsqlite3-sys` crate. `.cargo/config.toml` sets its documented compile flags to match Bun where possible and disable unsupported WASI facilities; it does not rewrite the amalgamation. No additional third-party source rewrites were found in crate build scripts. Test fixture npm packages are source inputs for compatibility tests, not runtime forks.

