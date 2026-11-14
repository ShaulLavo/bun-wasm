import type { ProcessService, RuntimeProcessContext } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { createProcessFilesystemIdentity, reapFilesystem, revokeFilesystem, type FilesystemIdentity } from "waffle/fs/protocol";
import { createFilesystemDescriptorCodec } from "waffle/proc/filesystem-codec";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { createWorkerPipeCodec } from "waffle/proc/worker-pipes";
import { attachPipePublicationRegistry } from "waffle/proc/pipes";
import { WorkerProcessClient, workerProcessPipeRegistry, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import type { SpawnRequest } from "waffle/proc/types";

function prepare(filesystem: FilesystemClient, identity: FilesystemIdentity, registry: ReturnType<typeof attachPipePublicationRegistry>, pid: number) {
  const release = filesystem.beginTransfer();
  let child: FilesystemIdentity | undefined;
  let enrolled = false;
  const cancel = () => {
    if (child) { revokeFilesystem(child); reapFilesystem(child); }
    if (enrolled) registry.collectProcess(pid);
  };
  try {
    child = createProcessFilesystemIdentity(identity);
    registry.registerProcess(pid);
    enrolled = true;
    return { data: { filesystem: child, pipeRegistry: registry.handle() }, release, cancel,
      codec: createRuntimeTerminalCodec({ fallback: createWorkerPipeCodec({ fallback: createFilesystemDescriptorCodec(filesystem, child) }) }),
    };
  } catch (error) {
    try { cancel(); }
    finally { release(); }
    throw error;
  }
}

/** The ordinary runtime-proc spawn path supplies the transport a real Bash Worker requires. */
export class PackageChildren {
  readonly filesystem: FilesystemClient;
  private readonly client: WorkerProcessClient;
  private readonly notices: WorkerProcessMessage[] = [];

  constructor(filesystem: FilesystemClient, private readonly service: ProcessService, private readonly context: RuntimeProcessContext, transport: WorkerProcessTransport, identity: FilesystemIdentity) {
    this.filesystem = filesystem;
    const registry = attachPipePublicationRegistry(workerProcessPipeRegistry(transport));
    this.client = new WorkerProcessClient({ transport, descriptors: context.descriptors,
      registerRevocation: context.registerRevocation,
      codec: createRuntimeTerminalCodec({ fallback: createWorkerPipeCodec() }),
      postMessage: message => this.notices.push(message),
      prepareSpawn: pid => prepare(this.filesystem, identity, registry, pid),
    });
  }

  reserve(request: SpawnRequest): number { return this.client.spawn(this.context.pid, request); }
  async flush(): Promise<void> {
    for (let message = this.notices.shift(); message; message = this.notices.shift()) await this.service.runtimeMessage(message, this.context.pid);
  }
  wait(pid: number) { return this.client.wait(this.context.pid, pid); }
}
