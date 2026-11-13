import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProgramInputSnapshot } from "./guest-core-receipt.ts";

export async function writeProgramDelivery(output: string, files: readonly { name: string; bytes: Uint8Array }[], delivery: { source: ProgramInputSnapshot["source"] }): Promise<void> {
  await mkdir(output);
  try {
    for (const file of files) await Bun.write(join(output, file.name), file.bytes);
    await Bun.write(join(output, "source.txt"), `${delivery.source.head}\n${delivery.source.tree}\n`);
    await Bun.write(join(output, "delivery.json"), JSON.stringify(delivery, null, 2) + "\n");
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
