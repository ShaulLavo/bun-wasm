# Security policy

bun-wasm runs JavaScript apps in a browser tab on a WebAssembly runtime. Reports about the sandbox boundary are welcome.

## Report a vulnerability

Use GitHub's private vulnerability reporting. Open the repository's **Security** tab and choose **Report a vulnerability**, or go to <https://github.com/ShaulLavo/bun-wasm/security/advisories/new>.

Include the commit or version, what you did, what happened, and what you expected. Redact real hostnames, keys, and tokens.

There is no bug bounty and no response-time commitment. This is a personal project.

## Supported versions

bun-wasm is pre-1.0. Only the `main` branch receives fixes.

## Scope

Running code escaping the browser sandbox model, and tampering with the published guest (its SHA-256 check), are in scope. See [limits](docs/limits.md) for known gaps.
