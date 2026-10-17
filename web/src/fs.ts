// Direct memory backend for host unit tests and standalone non-worker consumers.
// Browser pages and guests use shared-fs.ts and the runtime filesystem client instead.
export * from "waffle/fs/memory";
