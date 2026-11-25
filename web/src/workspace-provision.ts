import type { Runtime } from "waffle";
import {
  acquireLockHandle,
  fenceDeadWriters,
  liveWritersLockName,
  type ClaimsEnvironment,
} from "./workspace-claims";

type Filesystem = Runtime["filesystem"];

function provisionSeedLockName(workspaceName: string): string {
  return `bun-wasm:provision-seed:${workspaceName}`;
}

function provisionBinsLockName(workspaceName: string): string {
  return `bun-wasm:provision-bins:${workspaceName}`;
}

export interface ProvisionLockOptions {
  signal?: AbortSignal;
  env?: ClaimsEnvironment;
  onWaiting?: () => void;
  waitingDelayMs?: number;
}

async function withWorkspaceExclusiveLock<T>(
  lockName: string,
  workspaceName: string,
  fs: Pick<Filesystem, "fork">,
  ownClaimIds: ReadonlySet<string>,
  fn: () => Promise<T>,
  options: ProvisionLockOptions = {},
): Promise<T> {
  const signal = options.signal;
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.onWaiting) {
    timer = setTimeout(() => {
      if (!signal?.aborted) options.onWaiting?.();
    }, options.waitingDelayMs ?? 500);
  }
  const handle = await acquireLockHandle(lockName, {
    mode: "exclusive",
    signal,
    locks: options.env?.locks,
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (!handle) throw new Error(`Failed to acquire exclusive lock ${lockName}`);
  try {
    await fenceDeadWriters(workspaceName, fs, ownClaimIds, { signal, env: options.env });
    signal?.throwIfAborted();
    return await fn();
  } finally {
    handle.release();
  }
}

export function withProvisionSeedLock<T>(
  workspaceName: string,
  fs: Pick<Filesystem, "fork">,
  ownClaimIds: ReadonlySet<string>,
  fn: () => Promise<T>,
  options: ProvisionLockOptions = {},
): Promise<T> {
  return withWorkspaceExclusiveLock(
    provisionSeedLockName(workspaceName),
    workspaceName,
    fs,
    ownClaimIds,
    fn,
    options,
  );
}

export function withProvisionBinsLock<T>(
  workspaceName: string,
  fs: Pick<Filesystem, "fork">,
  ownClaimIds: ReadonlySet<string>,
  fn: () => Promise<T>,
  options: ProvisionLockOptions = {},
): Promise<T> {
  return withWorkspaceExclusiveLock(
    provisionBinsLockName(workspaceName),
    workspaceName,
    fs,
    ownClaimIds,
    fn,
    options,
  );
}

/**
 * Attempts to acquire `workspaceLiveWritersLock` exclusively (`ifAvailable: true`).
 * If another tab already holds a shared live-writer lease, skips destructive work cleanly.
 * If granted, re-runs `fenceDeadWriters()` INSIDE the exclusive lock before invoking `fn()`.
 */
export async function withExclusiveLiveWriters<T>(
  workspaceName: string,
  fs: Pick<Filesystem, "fork">,
  ownClaimIds: ReadonlySet<string>,
  fn: () => Promise<T>,
  options: { signal?: AbortSignal; env?: ClaimsEnvironment } = {},
): Promise<{ skipped: true } | { skipped: false; value: T }> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const handle = await acquireLockHandle(liveWritersLockName(workspaceName), {
    mode: "exclusive",
    ifAvailable: true,
    locks: options.env?.locks,
  });
  if (!handle) return { skipped: true };
  try {
    await fenceDeadWriters(workspaceName, fs, ownClaimIds, { signal, env: options.env });
    signal?.throwIfAborted();
    const value = await fn();
    return { skipped: false, value };
  } finally {
    handle.release();
  }
}

const OLD_PREVIEW_MOUNT_REGEX = "/^\\/(?:[^/?#\\\\]+\\/)*__preview\\/([1-9]\\d{0,4})\\/$/";
const NEW_PREVIEW_MOUNT_REGEX = "/^\\/(?:[^/?#\\\\]+\\/)*__preview\\/(?:r\\/(?:ws|mem|pg)-[a-zA-Z0-9._-]+\\/)?([1-9]\\d{0,4})\\/$/";

/**
 * Idempotently upgrades previously seeded React Router `app/preview-context.ts` files
 * to accept routed `/__preview/r/<route>/<port>/` headers alongside unrouted mounts.
 */
export async function upgradeReactRouterPreviewMount(
  fs: Pick<Filesystem, "readFile" | "writeFile" | "flush">,
  rootDir: string,
): Promise<boolean> {
  const filePath = `${rootDir}/app/preview-context.ts`;
  const bytes = await fs.readFile(filePath);
  if (!bytes) return false;
  const text = new TextDecoder().decode(bytes);
  if (!text.includes(OLD_PREVIEW_MOUNT_REGEX)) return false;
  const updated = text.replace(OLD_PREVIEW_MOUNT_REGEX, NEW_PREVIEW_MOUNT_REGEX);
  await fs.writeFile(filePath, updated);
  await fs.flush(filePath);
  return true;
}

/**
 * Atomically removes owned executable markers with `remove(path, { ifContent })`
 * and flushes durably. Collects all failures via `Promise.allSettled`.
 */
export async function rollbackMarkersDurably(
  fs: Pick<Filesystem, "remove" | "flush">,
  paths: readonly string[],
  expectedContent: Uint8Array,
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(paths).reverse().map((path) => fs.remove(path, { ifContent: expectedContent })),
  );
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  try {
    await fs.flush();
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) {
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Durable marker rollback failed");
  }
}
