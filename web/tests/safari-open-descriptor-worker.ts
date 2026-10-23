import { FilesystemClient, type FilesystemConnection } from "waffle/fs";

let opened: { client: FilesystemClient; root: ReturnType<FilesystemClient["preopen"]>; file: ReturnType<FilesystemClient["preopen"]> } | undefined;
function open(connection: FilesystemConnection) {
  const client = new FilesystemClient(connection);
  const root = client.preopen("/");
  const path = client.resolve(root, "held.bin");
  if (typeof path === "number") throw new Error(`resolve held.bin: ${path}`);
  const file = client.create(path, "file", false);
  if (typeof file !== "number") throw new Error(`open held.bin: ${file.error}`);
  client.retain(root); client.retain(file);
  opened = { client, root, file };
  postMessage({ opened: true });
}
function read() {
  if (!opened) throw new Error("descriptor not opened");
  const { client, root, file } = opened;
  try {
    const bytes = new Uint8Array(5);
    const count = client.read(file, [bytes], 0);
    postMessage({ count, bytes: Array.from(bytes) });
  } finally {
    client.release(file); client.release(root); client.dispose(); opened = undefined;
  }
}
onmessage = (event: MessageEvent<{ kind: "open"; connection: FilesystemConnection } | { kind: "read" }>) => {
  try {
    if (event.data.kind === "open") open(event.data.connection);
    else read();
  } catch (error) { postMessage({ error: String(error) }); }
};
