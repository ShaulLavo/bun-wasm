// A workspace's preview identity: a random value stored inside the workspace, so every tab reads
// the same one, and a deleted and recreated workspace gets a new one. Preview hostnames derive from
// it, so a recreated workspace never inherits the cookies or storage of the one it replaced.
interface IdentityFilesystem {
  readFile(path: string): Promise<Uint8Array | null | undefined>;
  writeFile(path: string, data: string): Promise<unknown>;
  mkdirp(path: string): Promise<unknown>;
  flush(path?: string): Promise<unknown>;
}

const DIRECTORY = ".bun-wasm";
const FILE = "preview-identity";
const SHAPE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** The stored identity, or null when the workspace has none yet. */
export async function readPreviewIdentity(fs: Pick<IdentityFilesystem, "readFile">, home: string): Promise<string | null> {
  const bytes = await fs.readFile(`${home}/${DIRECTORY}/${FILE}`);
  const text = bytes ? new TextDecoder().decode(bytes).trim() : "";
  return SHAPE.test(text) ? text : null;
}

/** Creates and stores the identity. The caller holds the workspace's writer claim. */
export async function createPreviewIdentity(fs: IdentityFilesystem, home: string): Promise<string> {
  const existing = await readPreviewIdentity(fs, home);
  if (existing) return existing;
  const identity = crypto.randomUUID();
  await fs.mkdirp(`${home}/${DIRECTORY}`);
  await fs.writeFile(`${home}/${DIRECTORY}/${FILE}`, `${identity}\n`);
  await fs.flush(`${home}/${DIRECTORY}/${FILE}`);
  return identity;
}
