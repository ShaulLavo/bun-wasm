import type { Shell as PlaygroundShell } from "../../src/shell";

/** A loaded but nonexecuting module at the artifact-free editor boundary. */
export async function loadEditorEngine() {
  const bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  return { module: new WebAssembly.Module(bytes), size: bytes.length, build: null };
}

/** The editor gate must never stand in for a shell/guest execution test. */
export class EditorOnlyShell {
  readonly running = false;
  readonly lastExit = 0;

  static async create(options: Parameters<typeof PlaygroundShell.create>[0]): Promise<EditorOnlyShell> {
    options.onState("ready");
    return new EditorOnlyShell();
  }

  input(_data: string | Uint8Array): never { throw new Error("The artifact-free editor gate must not send shell input"); }
  submit(_command: string): never { throw new Error("The artifact-free editor gate must not execute a guest"); }
  resize(_cols: number, _rows: number): void {}
  async dispose(): Promise<void> {}
}
