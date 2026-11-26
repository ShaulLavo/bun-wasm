/**
 * Guest environment for the page hosts (the sandbox and the playground). The browser already
 * keeps registry responses in its HTTP cache and in Cache Storage, so `bun install` keeps no
 * install cache of its own in the workspace filesystem, where writing and reading it back costs
 * more than fetching again. Native hosts don't set it and keep their disk cache.
 */
export const PAGE_INSTALL_ENV = { BUN_WASM_INSTALL_CACHE: "off" } as const;
