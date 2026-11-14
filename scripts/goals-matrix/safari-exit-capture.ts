import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macNative } from "./safari-causal-native";
import { ExitOwner } from "./safari-exit-observer";
import { exitJSON, jsonlSink } from "./safari-exit-sink";

export const exitSettlementFile = "native-exit-settlement.json";
type Setup = () => Promise<Pick<ConstructorParameters<typeof ExitOwner>[0], "native" | "open"> & { dispose?(): void }>;

async function nativeSetup(): ReturnType<Setup> {
  const { nativeExitFactory } = await import("./safari-exit-native");
  return { native: macNative(), ...nativeExitFactory() };
}

/** Opens before native setup and settles after independently attempted driver/app teardown. */
export async function withSafariExitCapture<T>(output: string, operation: (owner: ExitOwner) => Promise<T>, setup: Setup = nativeSetup): Promise<T> {
  const logs = join(output, "logs");
  await mkdir(logs, { recursive: true });
  const id = crypto.randomUUID();
  const file = `native-exit-${id}.jsonl`;
  const settlement = join(logs, exitSettlementFile);
  await writeFile(settlement, exitJSON({ schema: 1, id, state: "open", file }) + "\n", { mode: 0o600 });
  // Resolve the platform adapter before acquiring the writer. No descriptor is opened until association.
  const adapters = await setup();
  let owner: ExitOwner | undefined;
  let adapterClosed = false, adapterFailure: unknown = null;
  try {
    owner = new ExitOwner({ ...adapters, sink: await jsonlSink(join(logs, file)) });
    const active = owner;
    return await active.run(() => operation(active));
  }
  finally {
    try { adapters.dispose?.(); adapterClosed = true; }
    catch (error) { adapterFailure = error; }
    const proof = owner?.proof() ?? { state: "unproved" };
    try { await writeFile(settlement, exitJSON({ schema: 1, id, file, ...proof, state: adapterClosed ? proof.state : "unproved", adapterClosed, adapterFailure }) + "\n", { mode: 0o600 }); }
    catch { /* The open receipt remains unproved; diagnostics preserve the operation's outcome. */ }
  }
}
