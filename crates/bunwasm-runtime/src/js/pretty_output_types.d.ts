declare namespace BunWasm {
  interface PrettyOutputInternal {
    readonly native: { isatty(fd: number): boolean };
  }
  interface PrettyOutput {
    readonly RESET: string;
    /** Whether Bun writes ANSI colours to stdout (console.log) and stderr (errors, `bun test`). */
    readonly stdout: boolean;
    readonly stderr: boolean;
    prettyFmt(template: string, enabled: boolean): string;
    markup(enabled: boolean): (strings: TemplateStringsArray, ...values: unknown[]) => string;
  }
  interface Internal {
    require(name: "pretty_output"): PrettyOutput;
  }
}
