import { expect, test } from "bun:test";
import { createRuntime } from "waffle";
import { FilesystemClient } from "waffle/fs";
import type { NetRequest } from "waffle/browser/net/protocol";
import { createRing } from "../src/net/ring";
import { createBunNetworkHelper, dispatchBunNetwork } from "../src/net/helper";

type Reply = { kind: "net"; req: NetRequest } | { kind: "listening"; path: string }
  | { kind: "done"; value: { payloadBytes: number; halfClose: boolean; response: string; closed: boolean } }
  | { kind: "error"; error: string };

test("Node adapter uses released Runtime100 socket nodes, streams, half-close and acknowledged unlink", async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", import.meta.resolve("waffle/browser/shared-fs")) } });
  const identity = runtime.filesystem.createIdentity();
  const client = new FilesystemClient(runtime.filesystem.connect(identity));
  const ring = createRing();
  let root: Awaited<ReturnType<typeof runtime.filesystem.directoryHandle>> | undefined;
  let helper: ReturnType<typeof createBunNetworkHelper> | undefined;
  let worker: Worker | undefined;
  const listening = Promise.withResolvers<string>();
  const completion = Promise.withResolvers<Extract<Reply, { kind: "done" }>["value"]>();
  let phase: "listening" | "running" = "listening";
  const fail = (error: Error) => phase === "listening" ? listening.reject(error) : completion.reject(error);
  const timeout = setTimeout(() => fail(new Error("Released Node socket fixture timed out")), 4000);
  try {
    await client.asyncCall("preopen", ["/"]);
    await runtime.filesystem.mkdirp("/run");
    root = await runtime.filesystem.directoryHandle("/");
    helper = createBunNetworkHelper(await runtime.network(), ring, { pathScope: { filesystem: identity, directory: root.handle } });
    const session = helper;
    worker = new Worker(new URL("./fixtures/node-net-path-released-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.kind === "net") return dispatchBunNetwork(session, { type: "net", req: data.req });
      if (data.kind === "listening") return listening.resolve(data.path);
      if (data.kind === "done") return completion.resolve(data.value);
      fail(new Error(data.error));
    };
    worker.onerror = event => fail(new Error(event.message));
    worker.postMessage({ ring });
    const path = await listening.promise;
    expect((await runtime.filesystem.lookup(path))?.kind).toBe("socket");
    phase = "running";
    worker.postMessage({ continue: true });
    const result = await completion.promise;
    expect(result).toEqual({ payloadBytes: 30, halfClose: true, response: "after EOF:Bun adapter over real Unix ✓", closed: true });
    expect(await runtime.filesystem.lookup(path)).toBeUndefined();
  } finally {
    clearTimeout(timeout);
    worker?.terminate();
    try { helper?.dispose(); } finally { root?.release(); client.dispose(); await runtime.dispose(); }
  }
});
