import type { Runtime } from "waffle";
import { programLauncher } from "./program-launcher";

interface ProgramUrls {
  readonly worker: URL;
  readonly shellWorker: URL;
  readonly shell: URL;
}

async function install(runtime: Runtime, urls: ProgramUrls) {
  const [{ installBase }, { installShellCommands }] = await Promise.all([import("waffle-base"), import("bash-web")]);
  const base = await installBase(runtime, { launcher: programLauncher(urls.worker) });
  try {
    const shell = await installShellCommands(runtime, { wasmUrl: urls.shell, workerUrl: urls.shellWorker });
    return {
      path: ["/usr/local/bin"].concat(base.path).join(":"),
      async dispose() {
        try { await shell.dispose(); }
        finally { await base.dispose(); }
      },
    };
  } catch (error) {
    await base.dispose();
    throw error;
  }
}

/** One app-owned install. Shell sessions borrow its runtime and do not install base again. */
export class BrowserPrograms {
  private installation: ReturnType<typeof install> | undefined;
  private closed = false;
  constructor(private readonly runtime: Runtime, private readonly urls: ProgramUrls) {}

  ready() {
    if (this.closed) return Promise.reject(new Error("Browser programs are closed"));
    return this.installation ??= install(this.runtime, this.urls).then(async installed => {
      if (!this.closed) return installed;
      await installed.dispose();
      throw new Error("Browser programs closed during installation");
    });
  }

  /** The page starts runtime shutdown before awaiting this fence on its guests. */
  dispose(): Promise<void> {
    this.closed = true;
    return this.installation?.then(installed => installed.dispose(), () => {}) ?? Promise.resolve();
  }
}
