declare namespace BunWasm {
  interface Native {
    /** Returns a negative precommit WASI errno. Successful replacement never returns. */
    packageScriptsHandoff(plan: string): number;
  }
}
