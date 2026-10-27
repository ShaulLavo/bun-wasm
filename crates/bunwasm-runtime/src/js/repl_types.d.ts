declare namespace BunWasm {
  interface ReplInput {
    isTTY?: boolean;
    on(event: string, listener: (...args: never[]) => void): unknown;
    off(event: string, listener: (...args: never[]) => void): unknown;
    pause(): unknown;
  }
  interface ReplOutput { isTTY?: boolean; write(chunk: string): unknown }
  interface ReplProcess {
    stdin: ReplInput;
    stdout: ReplOutput;
    stderr: ReplOutput;
    on(event: "SIGINT", listener: () => void): unknown;
    off(event: "SIGINT", listener: () => void): unknown;
  }
  interface ReplBun {
    version: string;
    Transpiler: new (options: { loader: string; replMode: boolean }) => { transformSync(code: string): string };
    inspect(value: unknown, options?: { colors?: boolean }): string;
  }
}
