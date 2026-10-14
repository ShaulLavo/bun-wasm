// Placeholder until the bun:test implementation lands.
(function (internal) {
  "use strict";
  return {
    exports: {},
    run() {
      internal.native.writeStderr("bun test is not implemented yet\n");
      globalThis.process.exitCode = 1;
    },
  };
})
