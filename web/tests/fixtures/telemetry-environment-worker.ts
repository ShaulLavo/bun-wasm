import { createBunExecutor, type RunRequest } from "../../src/bun-executor";
import { createFilesystemIdentity } from "waffle/fs/protocol";
import { DescriptorTable } from "waffle/core/descriptors";
import { WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { attachTerminalOutput } from "../../../node_modules/waffle/browser/terminal-output";

function reportEnvironment(data: RunRequest, env: Record<string, string>) {
  const identity = workerProcessState(data.runtimeProcess!);
  const bytes = new TextEncoder().encode(JSON.stringify({ env, pid: identity.pid, parentPid: identity.parentPid }) + "\n");
  if (!data.terminalOutput) {
    self.postMessage({ type: "stdout", data: bytes });
    return;
  }
  const notify = () => self.postMessage({ type: "terminal-output" });
  const output = attachTerminalOutput(data.terminalOutput, {
    checkActive() {}, interrupted: () => false, doorbell: notify,
  });
  output.write(1, [bytes]);
  notify();
}

async function observe(data: RunRequest) {
  const executor = createBunExecutor(data);
  const descriptors = new DescriptorTable();
  try {
    const env = executor.env?.(data) ?? data.env;
    reportEnvironment(data, env);
    if (data.args.includes("--spawn-child")) await observeChild(data, env, descriptors);
    self.postMessage({ type: "exit", code: 0 });
  } finally {
    descriptors.dispose();
    executor.beforeFinish?.();
    data.filesystem.port.close();
  }
}

async function observeChild(data: RunRequest, env: Record<string, string>, descriptors: DescriptorTable) {
  const transport = data.runtimeProcess!;
  const inherited = transport.data;
  if (!inherited || typeof inherited !== "object" || !("pipeRegistry" in inherited)) throw new Error("child pipe registry required");
  const client = new WorkerProcessClient({ transport, descriptors,
    codec: { export() { throw new Error("unexpected export"); }, import() { throw new Error("unexpected import"); }, discard() {} },
    postMessage: message => self.postMessage(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(data.filesystem), pipeRegistry: inherited.pipeRegistry } }),
  });
  const pid = client.spawn(client.pid, { executable: env.BUNWASM_EXEC_PATH!, argv: ["bun", "--environment-control"], cwd: env.PWD!, env, job: -1, fds: [] });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = client.wait(client.pid, pid);
    if (!result) {
      await new Promise(resolve => setTimeout(resolve, 1));
      continue;
    }
    if (result.status !== 0) throw new Error("environment child failed");
    return;
  }
  throw new Error("environment child did not finish");
}

self.onmessage = ({ data }: MessageEvent<RunRequest>) => {
  void observe(data).catch(error => self.postMessage({ type: "error", message: String(error) }));
};
