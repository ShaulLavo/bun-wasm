The runtime uses @js-temporal/polyfill 0.5.1 for TOML's date and time values
when the JS engine does not provide Temporal. Bun's Rust parser identifies
the literal and its type; the polyfill constructs that Temporal value.

Run `source env.sh && python3 scripts/vendor-temporal.py` from the repository
root to rebuild `crates/bunwasm-runtime/src/js/temporal.js`. The script installs
the locked packages in a disposable directory on /work and removes it on exit.
The bundle includes JSBI. Both licenses are preserved here.
