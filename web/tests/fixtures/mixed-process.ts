import { DescriptorTable } from "waffle/core/descriptors";
import { ProcessABI } from "waffle/proc/abi";
import { ProcessSupervisor } from "waffle/proc/supervisor";
import { ExecutableRegistry } from "waffle/proc/registry";
import { PipeController } from "waffle/proc/pipes";
import { MemFS } from "../../src/fs";

export function processFixture(shared = false) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared });
  const descriptors = new DescriptorTable();
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch() { throw new Error("Unused launch"); } });
  const pid = supervisor.createRoot({ descriptors });
  const signals = supervisor.get(pid)!;
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const pipe = new PipeController({ capacity: 8, wake, relay: "manual" });
  const reader = pipe.retain(pid, "read"), writer = pipe.retain(pid, "write");
  const fd = descriptors.open(reader, (1n << 29n) - 1n, (1n << 29n) - 1n);
  const writeFd = descriptors.open(writer, (1n << 29n) - 1n, (1n << 29n) - 1n);
  const abi = new ProcessABI({ memory, descriptors, fs: new MemFS(), pid, service: supervisor, signals, wake });
  return {
    memory, descriptors, abi, fd, writeFd, reader, writer, signals,
    subscription(ptr = 64, kind = 0, id = fd) {
      const view = new DataView(memory.buffer);
      view.setUint32(ptr, kind, true); view.setUint32(ptr + 4, id, true); view.setBigUint64(ptr + 8, 91n, true);
      return new Uint8Array(memory.buffer, ptr, 16);
    },
    dispose() { writer.close(); descriptors.dispose(); pipe.dispose(); supervisor.dispose(); },
  };
}
