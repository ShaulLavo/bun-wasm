import { expect, test } from "bun:test";
import type { Runtime, RuntimeProcessContext } from "../../node_modules/waffle/index.ts";
import type { Stream } from "../../node_modules/waffle/core/descriptors.ts";
import { setSignalDisposition, SignalDisposition } from "../../node_modules/waffle/proc/signals.ts";
import { packageContinuation, admittedIdentity } from "../../src/package-continuation.js";
import { parsePackagePlan } from "../../src/package-continuation-plan.js";
import { startupDiagnostic } from "../../src/package-continuation-diagnostics.js";
import { fixture, plan, using, exit, main } from "./fixtures/package-continuation.js";

function testRuntime(name: string, run: Parameters<typeof using>[0]) { test(name, () => using(run)); }

test("private plan snapshots prepared phases and actual environment, rejecting malformed boundaries", () => {
  const source = plan({ pre: { name: "prebuild", original: "pre", command: "pre" } });
  const parsed = parsePackagePlan(source);
  expect(parsed).toEqual(source);
  expect(parsed.env).not.toBe(source.env);
  expect(Object.isFrozen(parsed.main)).toBe(true);
  expect(() => parsePackagePlan({ ...source, cwd: "relative" })).toThrow();
  expect(() => parsePackagePlan({ ...source, pre: { ...main } })).toThrow();
  expect(() => parsePackagePlan({ ...source, env: { BAD: 1 } })).toThrow();
});

testRuntime("all phases use independent actual env/cwd and repeat real access lookup", async f => {
    const seen: Array<{ argv: string[]; env: Record<string, string>; cwd: string; job: number }> = [];
    await f.register("/bin/bash", (context) => {
      seen.push({ argv: context.request.argv, env: context.request.env, cwd: context.request.cwd, job: context.job });
      if (context.started()) context.exit(0);
      return { terminate() {} };
    });
    const value = plan({ cwd: "/project", env: { PATH: "missing::relative:/bin", EMPTY: "", npm_execpath: "/actual/bun", PWD: "/project" },
      pre: { name: "prebuild", original: "pre original", command: "pre prepared" }, post: { name: "postbuild", original: "post original", command: "post prepared" } });
    await f.runtime.filesystem.mkdirp("/project");
    const run = await f.start(value);
    expect(await run.exit).toMatchObject({ kind: "exited", code: 0 });
    expect(seen.map(item => item.argv)).toEqual([["/bin/bash", "-c", "pre prepared"], ["/bin/bash", "-c", "prepared"], ["/bin/bash", "-c", "post prepared"]]);
    expect(seen.map(item => item.env.npm_lifecycle_script)).toEqual(["pre original", "original", "post original"]);
    expect(seen.every(item => item.env.EMPTY === "" && item.env.npm_execpath === "/actual/bun" && item.cwd === "/project" && item.job === f.parent().job)).toBe(true);
    expect(f.shell.output.join("")).toBe("$ pre prepared\n$ prepared\n$ post prepared\n");
});

for (const phase of ["pre", "main", "post"] as const) {
  testRuntime(`failure in ${phase} stops later phases and preserves exit`, async f => {
      const seen: string[] = [];
      await f.register("/bin/bash", context => {
        const event = context.request.env.npm_lifecycle_event ?? "";
        seen.push(event);
        if (context.started()) context.exit(event === (phase === "main" ? "build" : `${phase}build`) ? 23 : 0);
        return { terminate() {} };
      });
      const run = await f.start(plan({ pre: { ...main, name: "prebuild" }, post: { ...main, name: "postbuild" } }));
      expect(await run.exit).toMatchObject({ kind: "exited", code: 23 });
      expect(seen.length).toBe(["pre", "main", "post"].indexOf(phase) + 1);
      expect(f.shell.output.join("")).toEndWith(`error: script "${seen.at(-1)}" exited with code 23\n`);
  });
}

for (const mode of ["exit143", "term", "int", "code2", "silent", "color"] as const) {
  testRuntime(`typed outcome and exact script diagnostic: ${mode}`, async f => {
      await f.register("/bin/bash", context => {
        if (context.started() && (mode === "term" || mode === "int")) context.defaultSignal(mode === "term" ? 15 : 2);
        else context.exit(mode === "code2" ? 2 : 143);
        return { terminate() {} };
      });
      const run = await f.start(plan({ silent: mode === "silent", color: mode === "color" }));
      const outcome = await run.exit;
      expect(outcome).toMatchObject({ kind: mode === "term" || mode === "int" ? "signaled" : "exited", code: mode === "term" ? 15 : mode === "int" || mode === "code2" ? 2 : 143 });
      const expected = mode === "silent" ? "" : mode === "color" ? "\x1b[0m\x1b[2m\x1b[35m$\x1b[0m \x1b[2m\x1b[1mprepared\x1b[0m\n" : "$ prepared\n";
      const failure = mode === "term" ? 'error: script "build" was terminated by signal SIGTERM\n' : mode === "int" || mode === "code2" || mode === "silent" ? "" : 'error: script "build" exited with code 143\n';
      expect(f.shell.output.join("")).toBe(expected + failure);
  });
}

test("captured missing/denied startup error is emitted once; disposal never echoes work failure", async () => {
  for (const mode of ["missing", "denied"]) {
    await using(async f => {
      if (mode === "denied") await f.runtime.filesystem.writeFile("/bin/sh", "unregistered");
      const run = await f.start(plan({ silent: true }));
      expect(await run.exit).toMatchObject({ kind: "exited", code: 1 });
      const output = f.shell.output.join("");
      expect(output.match(/error: spawn/g)?.length).toBe(1);
      expect(output).not.toContain("runtime: process start failed");
      expect(output).not.toContain('script "');
    });
  }
});

testRuntime("malformed committed plan reports original execution failure once and stop does not rethrow", async f => {
    const run = await f.shell.spawn("/continuation", ["/continuation", "not json"]);
    expect(await run.exit).toMatchObject({ kind: "exited", code: 126 });
});

test("live inherited stderr rights and partial/EAGAIN writes finish before child admission", async () => {
  const notification = new Int32Array(new SharedArrayBuffer(4));
  const entered = Promise.withResolvers<void>();
  let allowed = false;
  let text = "";
  let children = 0;
  const stream: Stream = { kind: "terminal", notification, read: () => 0, write: () => 0, readiness: () => ({ readable: true, writable: allowed, hangup: false }), tryWrite(chunks) {
    if (!allowed) { entered.resolve(); return -6; }
    const byte = chunks[0]?.subarray(0, 1) ?? new Uint8Array();
    text += new TextDecoder().decode(byte);
    return byte.length;
  } };
  let runtime: Runtime;
  const f = await fixture((context, service) => {
    const resource = context.descriptors.get(2)?.resource;
    if (resource?.kind !== "terminal") throw new Error("Missing terminal");
    Object.assign(resource, stream);
    return packageContinuation(runtime)(context, service);
  });
  runtime = f.runtime;
  try {
    await f.register("/bin/bash", context => { children++; return exit(0)(context, f.service); });
    const run = await f.start();
    await entered.promise;
    expect(children).toBe(0);
    allowed = true;
    Atomics.add(notification, 0, 1); Atomics.notify(notification, 0);
    expect(await run.exit).toMatchObject({ kind: "exited", code: 0 });
    expect(text).toBe("$ prepared\n");
  } finally { await f.dispose(); }
});

test("revocation during announcement cancels backpressure and never starts a child", async () => {
  const entered = Promise.withResolvers<void>();
  let children = 0;
  let runtime: Runtime;
  const f = await fixture((context, service) => {
    const resource = context.descriptors.get(2)?.resource;
    if (resource?.kind !== "terminal") throw new Error("Missing terminal");
    Object.assign(resource, { notification: new Int32Array(new SharedArrayBuffer(4)), tryWrite: () => { entered.resolve(); return -6; } });
    return packageContinuation(runtime)(context, service);
  });
  runtime = f.runtime;
  try {
    await f.register("/bin/bash", context => { children++; return exit(0)(context, f.service); });
    const run = await f.start();
    await entered.promise;
    await run.kill();
    expect(await run.exit).toMatchObject({ kind: "signaled", code: 9 });
    expect(children).toBe(0);
  } finally { await f.dispose(); }
});

testRuntime("held child, ignored signal, fatal winner and same-job sibling survive adapter cleanup", async f => {
    const entered = Promise.withResolvers<RuntimeProcessContext>();
    let childStops = 0;
    await f.register("/bin/bash", context => { context.started(); entered.resolve(context); return { terminate() { childStops++; } }; });
    await f.register("/sibling", context => { context.started(); return { terminate() {} }; });
    const run = await f.start();
    const child = await entered.promise;
    const parent = f.parent();
    const sibling = f.supervisor.reserveSpawn(parent.parentPid, { executable: "/sibling", argv: [], cwd: "/", env: {}, fds: [], job: parent.job });
    await f.supervisor.start(sibling);
    setSignalDisposition(parent.signalState, 15, SignalDisposition.IGNORE, parent.interrupt);
    await f.service.kill(parent.pid, 15);
    expect(f.supervisor.childExited(parent.parentPid, parent.pid)).toBe(false);
    await run.kill();
    child.exit(0);
    expect(await run.exit).toMatchObject({ kind: "signaled", code: 9 });
    expect(f.supervisor.childExited(parent.parentPid, sibling)).toBe(false);
    expect(f.shell.output.join("")).toBe("$ prepared\n");
    f.supervisor.exit(sibling, 0);
    expect(childStops).toBe(1);
});

test("descriptor WRITE denial, closed stderr and EPIPE are real output failures", async () => {
  for (const mode of ["rights", "closed", "pipe"]) {
    let runtime: Runtime;
    const f = await fixture((context, service) => {
      context.descriptors.close(2);
      if (mode !== "closed") context.descriptors.openAt(2, { kind: "terminal", read: () => 0, write: () => -64, tryWrite: () => -64, readiness: () => ({ readable: true, writable: true, hangup: true }) }, mode === "rights" ? 0n : 64n, 0n);
      return packageContinuation(runtime)(context, service);
    });
    runtime = f.runtime;
    try { expect(await (await f.start()).exit).toMatchObject({ kind: "exited", code: 126 }); }
    finally { await f.dispose(); }
  }
});

test("renderer retains every supported startup errno including unmapped ELOOP", () => {
  expect(startupDiagnostic("/sh", 44, "detail\nsecond", "footer\n")).toBe('error: spawn /sh ENOENT: detail\nsecond\n   errno: -2,\n syscall: "spawn",\n    path: "/sh",\n    code: "ENOENT"\n\n\nfooter\n');
  expect(startupDiagnostic("/sh", 32, "", "")).toContain("errno: undefined");
});

testRuntime("failed executable preparation preserves its EACCES detail even in silent mode", async f => {
  await f.register("/bin/bash", exit(0), () => Promise.reject(Object.assign(new Error("preparation denied\nsecond detail"), { code: "EACCES" })));
  expect(await (await f.start(plan({ silent: true }))).exit).toMatchObject({ kind: "exited", code: 1 });
  const output = f.shell.output.join("");
  expect(output).toStartWith("error: spawn /bin/bash EACCES: ");
  expect(output).toContain("preparation denied\nsecond detail");
  expect(output.match(/error: spawn/g)?.length).toBe(1);
  expect(output).not.toContain("runtime: process start failed");
});

test("live file stderr appends through a sparse alias with shared offsets and passes only stdio to children", async () => {
  let alias: ReturnType<RuntimeProcessContext["descriptors"]["get"]>;
  const f = await fixture(undefined, (context, filesystem) => {
    const root = context.descriptors.rootPreopen();
    if (root?.resource.kind !== "directory") throw new Error("Missing fixture root");
    const resolved = filesystem.resolve(root.resource.handle, "output", true);
    if (typeof resolved === "number" || resolved.node === undefined) throw new Error("Missing output fixture");
    const handle = resolved.node;
    filesystem.retain(handle);
    filesystem.reserve(handle, admittedIdentity(context, f.service));
    context.descriptors.close(2);
    context.descriptors.openAt(2, { kind: "file", handle, offset: 2, append: true }, 64n, 0n, () => filesystem.release(handle));
    const descriptor = context.descriptors.get(2);
    if (!descriptor) throw new Error("Missing file stderr");
    context.descriptors.inherit(1000003, descriptor);
    alias = context.descriptors.get(1000003);
  });
  try {
    await f.runtime.filesystem.writeFile("/output", "prefix");
    await f.runtime.filesystem.drain();
    await f.register("/bin/bash", context => {
      expect(context.descriptors.get(1000003)).toBeUndefined();
      expect(context.descriptors.inheritable()).toEqual([0, 1, 2]);
      return exit(23)(context, f.service);
    });
    expect(await (await f.start()).exit).toMatchObject({ kind: "exited", code: 23 });
    const text = 'prefix$ prepared\nerror: script "build" exited with code 23\n';
    expect(new TextDecoder().decode(await f.runtime.filesystem.readFile("/output"))).toBe(text);
    expect(alias?.resource.kind === "file" && alias.resource.offset).toBe(text.length);
  } finally { await f.dispose(); }
});

for (const mode of ["moved", "reduced", "closed", "reused"] as const) {
  test(`cwd uses the inherited live root binding: ${mode}`, async () => {
    const f = await fixture(undefined, context => {
      const root = context.descriptors.get(3);
      if (!root) throw new Error("Missing root");
      if (mode === "reduced") { root.rightsBase = 0n; return; }
      if (mode === "moved") {
        context.descriptors.inherit(7, root);
        context.descriptors.renumber(3, 7);
        return;
      }
      context.descriptors.close(3);
      if (mode === "reused") context.descriptors.inherit(3, context.descriptors.get(1)!);
    });
    try {
      await f.register("/bin/bash", exit(0));
      const outcome = await (await f.start()).exit;
      expect(outcome).toMatchObject({ kind: "exited", code: mode === "moved" ? 0 : 1 });
      if (mode !== "moved") expect(f.shell.output.join("")).toContain(mode === "reduced" ? "ENOTCAPABLE" : "EBADF");
    } finally { await f.dispose(); }
  });
}

for (const cwd of ["/missing", "/file"]) {
  testRuntime(`bad cwd ${cwd} renders the ordinary startup diagnostic and starts no child`, async f => {
    let starts = 0;
    await f.runtime.filesystem.writeFile("/file", "file");
    await f.register("/bin/bash", context => { starts++; return exit(0)(context, f.service); });
    expect(await (await f.start(plan({ cwd }))).exit).toMatchObject({ kind: "exited", code: 1 });
    expect(starts).toBe(0);
    expect(f.shell.output.join("")).toContain(cwd === "/file" ? "ENOTDIR" : "ENOENT");
  });
}

testRuntime("each phase rechecks executable access after filesystem changes", async f => {
  const shells: string[] = [];
  await f.register("/bin/bash", (context) => {
    shells.push(context.request.executable);
    const work = f.runtime.filesystem.remove("/bin/bash").then(() => context.exit(0));
    context.started();
    return { async terminate() { await work; } };
  });
  await f.register("/bin/sh", context => { shells.push(context.request.executable); return exit(0)(context, f.service); });
  const outcome = await (await f.start(plan({ pre: { ...main, name: "prebuild" } }))).exit;
  expect(outcome).toMatchObject({ kind: "exited", code: 0 });
  expect(shells).toEqual(["/bin/bash", "/bin/sh"]);
});

test("revocation while service readiness is held prevents late admission", async () => {
  const ready = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let runtime: Runtime;
  const f = await fixture((context, service) => packageContinuation(runtime)(context, { ...service, async ready() {
    entered.resolve();
    await ready.promise;
    return service.ready();
  } }));
  runtime = f.runtime;
  try {
    const run = await f.start();
    await entered.promise;
    await run.kill();
    ready.resolve();
    expect(await run.exit).toMatchObject({ kind: "signaled", code: 9 });
    expect(f.errors).toEqual([]);
    expect(f.shell.output).toEqual([]);
  } finally { ready.resolve(); await f.dispose(); }
});

test("an exception inside the continuation body is reported once and stop joins a successful fence", async () => {
  const original = new Error("original adapter-body failure");
  let runtime: Runtime;
  const f = await fixture((context, service) => packageContinuation({ filesystem: { ...runtime.filesystem, connect() { throw original; } } })(context, service));
  runtime = f.runtime;
  try {
    expect(await (await f.start()).exit).toMatchObject({ kind: "exited", code: 126 });
    expect(f.errors).toEqual([original]);
  } finally { await f.dispose(); }
});
