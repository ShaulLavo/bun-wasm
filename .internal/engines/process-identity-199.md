# Process identity, issue 199

Status: Approved. Implementation blocked on the provider's thread identity contract.

Base: `bbf3165767cea786c920ca98c83dabda2588e36c`, fetched from `origin/main` on November 16, 2026. This work does not reuse the closed PR 218 ABI.

## Current contracts

The installed dependency is Waffle 0.0.138. Its `browser/process-context.ts` exports `RuntimeProcessIdentity`, with `pid`, `parentPid` and optional host identity. `WorkerSetupContext.identity` supplies that provider snapshot. `proc/types.ts` exposes the same ancestry through `ProcessLifecycle`. Root processes have parent PID zero; ancestry is captured at creation. `runtime_proc.getpid` exposes the execution record PID, but there is no `getppid` import.

Waffle's `SpawnRequest.worker` is explicitly opaque metadata for a guest thread started as a process. `WorkerProcessClient.reserveSpawnIntent` allocates a new PID unconditionally. The supervisor also reserves a new process record for a worker request. The provider has no distinction between an execution member ID and the identity of a process shared by threads.

Bun's `worker_threads.ts` calls the internal `spawnWorker` helper, which sets the existing worker metadata on an ordinary process spawn. Replacing the public constants with `runtime_proc.getpid` alone would therefore report each worker thread as a different process. Copying a parent PID through the worker environment would conceal the provider gap.

The native launcher already implements `runtime_proc.getpid` from its virtual `Processes.pid`. Its root record uses zero and children use the existing runtime allocator. Native workers also enter the ordinary child process path. The launcher's physical OS PID is unrelated to guest identity.

## Type and caller design

Keep allocation and ancestry in the provider. It must distinguish its execution/member handle from a shared process identity for thread members. The process identity contains a positive virtual PID and the creating process's PID, with zero only for a root's parent. A worker thread inherits that identity; its own execution handle remains available for lifecycle operations. A subprocess gets a fresh identity whose PID equals the subprocess handle returned to its parent. Creating a subprocess inside a thread uses the shared process PID as its visible parent identity.

The provider owner must define whether the existing `WorkerSetupContext.identity` changes meaning or a separate typed field supplies this identity. It must also specify the immutable creation-parent behavior after parent exit. Changing the lifecycle PID used for wait, signal, revocation and descriptor ownership is outside this consumer fix.

After that contract is available, add one data-native `processIdentity` returning `[pid, parentPid]`, shared by the engines. `process.ts` uses that pair for its existing properties. Browser and Node fixture hosts bind it from the provider context or shared transport. Native imports read the same logical identity from the existing virtual process records. Select and document any new scalar guest import only after the provider contract is settled. Do not introduce a second allocator or carry identity through environment variables.

## Reproduction and remaining gates

`reproduce.ts` beside the external result report runs two guest subprocesses and one worker thread, prints their identities, then asserts handle equality, distinct siblings, parent identity and shared thread identity. Native Bun is the control. The maintained Browser guest producer is run from the recorded base before changing runtime code.

The external report is `/work/reports/wave-20261116/engines/process-identity-199/RESULT.md`. It records actual commands, results and cleanup. No compiled guest result is inferred from source tests, tiny Wasm modules or a native Bun control.

The complete implementation still needs focused native and source tests, root and parent-exit checks, subprocess creation inside a worker, and actual QuickJS, JSC and Browser guest acceptance on the native and browser hosts. The draft is not ready for review or merge until these pass.
