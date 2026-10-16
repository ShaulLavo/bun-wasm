import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { PAGE } from "../../fs/protocol";
import { atomicHost } from "./wasi-atomic-host";

let run: (() => void) | undefined;
self.onmessage = event => {
  if (event.data === "write") { run!(); return; }
  const { connection, byte, scenario, exclusive } = event.data as { connection: FilesystemConnection; byte: number; scenario?: string; exclusive?: boolean };
  const fs = new FilesystemClient(connection);
  const host = atomicHost(fs);
  if (scenario === "create") {
    try { self.postMessage({ ...host.open("raced", exclusive ? 5 : 1), errors: host.errors }); }
    finally { host.wasi.descriptors.dispose(); fs.dispose(); }
    return;
  }
  const opened = host.open("shared", 0, 1);
  if (opened.error) throw new Error(`open failed: ${opened.error}`);
  const chunks = [new Uint8Array(PAGE + 7).fill(byte), new Uint8Array(13).fill(byte)];
  host.iovecs(chunks);
  run = () => {
    try {
      self.postMessage({ writing: true });
      const error = host.calls.fd_write!(opened.fd, 0, chunks.length, 1024);
      self.postMessage({ error, written: host.view().getUint32(1024, true), offset: host.tell(opened.fd), errors: host.errors });
    } finally { host.wasi.descriptors.dispose(); fs.dispose(); }
  };
  self.postMessage({ ready: true });
};
