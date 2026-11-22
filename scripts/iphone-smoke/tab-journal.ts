import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ownedTitle = /^Goals [\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

export function safariTabJournal(directory = join(homedir(), ".local/state/bun-wasm/c4d2-safari-tabs")) {
  function entry(title: string): string {
    if (!ownedTitle.test(title)) throw new Error("Invalid smoke Safari tab identity");
    return join(directory, title);
  }
  return {
    async pending(): Promise<Set<string>> {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const files = await readdir(directory, { withFileTypes: true });
      return new Set(files.filter(file => file.isFile() && ownedTitle.test(file.name)).map(file => file.name));
    },
    async record(title: string): Promise<void> {
      await writeFile(entry(title), "", { flag: "wx", mode: 0o600 });
    },
    async forget(title: string): Promise<void> {
      await rm(entry(title), { force: true });
    },
  };
}
