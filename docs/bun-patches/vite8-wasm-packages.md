# Vite 8 official Wasm packages

Status: implementation in progress on `wave1029/vite8-packages`.

This lane owns same-version official package selection for Lightning CSS, Rolldown and Oxc in the installer. It preserves upstream compiler APIs and errors. Generic Wasm shared memory, threads and napi support belong to Engines.

Current source implements `node:util.parseEnv`. The historical deployed Vite failure is not current-artifact evidence. The canonical engine producer must publish its verified pair before this lane claims guest acceptance.
