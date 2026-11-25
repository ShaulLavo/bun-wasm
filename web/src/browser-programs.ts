import type { Runtime } from "waffle";
import { programLauncher } from "./program-launcher";

export class ProvisionAbortedError extends Error {
  constructor(message = "Browser program provisioning was aborted") {
    super(message);
    this.name = "ProvisionAbortedError";
  }
}

export class ProvisionRollbackError extends AggregateError {
  constructor(errors: readonly unknown[], message = "Browser program rollback failed") {
    super(errors, message);
    this.name = "ProvisionRollbackError";
  }
}

export type ProvisioningStatus = "idle" | "pending" | "committed" | "rollback-failed";

interface ProgramUrls {
  readonly worker: URL;
  readonly shellWorker: URL;
  readonly shell: URL;
}

export interface BrowserProgramsOptions {
  /**
   * Optional transaction wrapper (admitProvision + provisionBinsLock + fenceDeadWriters + withWriterClaim).
   * Receives the transaction's abort signal.
   */
  readonly runTransaction?: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly onStateChange?: (state: ProvisioningStatus) => void;
}

export interface InstalledBrowserPrograms {
  readonly path: string;
  dispose(): Promise<void>;
}

const BASE_PROVISIONED_MARKER = "/usr/local/bin/.bunwasm-base-provisioned";
const BASE_MARKER_BYTES = new TextEncoder().encode("bunwasm-base-v1\n");

const modules = () => Promise.all([import("waffle-base"), import("bash-web")]);

async function installAndCommit(
  runtime: Runtime,
  urls: ProgramUrls,
  signal: AbortSignal,
  isClosed: () => boolean,
): Promise<InstalledBrowserPrograms> {
  const checkCancelled = () => {
    if (isClosed()) {
      throw new ProvisionAbortedError("Browser programs closed during installation");
    }
    if (signal.aborted || runtime.disposed) {
      throw new ProvisionAbortedError();
    }
  };
  checkCancelled();
  const [{ installBase }, { installShellCommands }] = await modules();
  checkCancelled();

  const base = await installBase(runtime, { launcher: programLauncher(urls.worker) });
  let shell: Awaited<ReturnType<typeof installShellCommands>> | undefined;
  let markerWritten = false;

  const rollback = async (primaryError: unknown): Promise<never> => {
    const rollbackErrors: unknown[] = [];
    if (markerWritten) {
      try {
        await runtime.filesystem.remove(BASE_PROVISIONED_MARKER, { ifContent: BASE_MARKER_BYTES });
      } catch (err) {
        rollbackErrors.push(err);
      }
    }
    const cleanups = await Promise.allSettled([
      shell ? shell.dispose() : Promise.resolve(),
      base.dispose(),
    ]);
    for (const res of cleanups) {
      if (res.status === "rejected") rollbackErrors.push(res.reason);
    }
    try {
      await runtime.filesystem.flush();
    } catch (err) {
      rollbackErrors.push(err);
    }
    if (rollbackErrors.length > 0) {
      throw new ProvisionRollbackError([primaryError, ...rollbackErrors]);
    }
    throw primaryError;
  };

  try {
    checkCancelled();
    shell = await installShellCommands(runtime, { wasmUrl: urls.shell, workerUrl: urls.shellWorker });
    checkCancelled();
    await runtime.filesystem.flush();
    checkCancelled();
    await runtime.filesystem.writeFile(BASE_PROVISIONED_MARKER, BASE_MARKER_BYTES);
    markerWritten = true;
    await runtime.filesystem.flush();
    checkCancelled();
    const installedShell = shell;
    return {
      path: ["/usr/local/bin"].concat(base.path).join(":"),
      async dispose() {
        const results = await Promise.allSettled([installedShell.dispose(), base.dispose()]);
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason);
        if (errors.length > 0) {
          throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Browser programs disposal failed");
        }
      },
    };
  } catch (error) {
    return await rollback(error);
  }
}

/** One app-owned install. Shell sessions borrow its runtime and do not install base again. */
export class BrowserPrograms {
  private committedInstallation: InstalledBrowserPrograms | undefined;
  private inFlight: Promise<InstalledBrowserPrograms> | undefined;
  private closed = false;
  private status: ProvisioningStatus = "idle";

  constructor(
    private readonly runtime: Runtime,
    private readonly urls: ProgramUrls,
    private readonly options: BrowserProgramsOptions = {},
  ) {}

  get state(): ProvisioningStatus {
    return this.status;
  }

  private setState(next: ProvisioningStatus): void {
    this.status = next;
    this.options.onStateChange?.(next);
  }

  /** Loads the installer code only. It writes nothing, so it may overlap workspace restoration. */
  preload(): void {
    void modules().catch(() => {});
  }

  /** Self-contained provisioning transaction. Only commits after flush + final abort check. */
  ready(): Promise<InstalledBrowserPrograms> {
    if (this.closed) return Promise.reject(new Error("Browser programs are closed"));
    if (this.committedInstallation) return Promise.resolve(this.committedInstallation);
    if (this.inFlight) return this.inFlight;

    const run = async (): Promise<InstalledBrowserPrograms> => {
      const execute = async (signal: AbortSignal): Promise<InstalledBrowserPrograms> => {
        this.setState("pending");
        try {
          const installed = await installAndCommit(this.runtime, this.urls, signal, () => this.closed);
          this.committedInstallation = installed;
          this.setState("committed");
          return installed;
        } catch (error) {
          if (error instanceof ProvisionRollbackError || error instanceof AggregateError) {
            this.setState("rollback-failed");
          } else {
            this.setState("idle");
          }
          throw error;
        }
      };

      if (this.options.runTransaction) {
        return await this.options.runTransaction(execute);
      }
      return await execute(new AbortController().signal);
    };

    const promise = run().finally(() => {
      if (this.inFlight === promise) this.inFlight = undefined;
    });
    this.inFlight = promise;
    return promise;
  }

  /** Disposes committed installation (or joins any in-flight install before disposing). */
  async dispose(): Promise<void> {
    this.closed = true;
    if (this.committedInstallation) {
      const installed = this.committedInstallation;
      this.committedInstallation = undefined;
      await installed.dispose();
      return;
    }
    if (this.inFlight) {
      const result = await this.inFlight.then(
        (installed) => ({ ok: true as const, installed }),
        () => ({ ok: false as const }),
      );
      if (result.ok) {
        if (this.committedInstallation === result.installed) this.committedInstallation = undefined;
        await result.installed.dispose();
      }
    }
  }
}
