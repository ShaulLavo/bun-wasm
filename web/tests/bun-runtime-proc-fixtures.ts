// Original byte-encoded external shell guest, following runtime-proc-fixtures.ts's ABI layout.
// This is intentionally not a Bun root: only its registered children execute Bun JavaScript.
import type { SpawnRequest } from "waffle/proc/types";

export interface BunRuntimeCommand {
  executable?: string;
  source: string;
  fds?: { child: number; parent: number | "reader" | "writer" }[];
  status?: number;
}
export interface BunRuntimeScenario {
  name: string;
  commands: BunRuntimeCommand[];
  pipe?: "pipeline" | "input" | "signal";
  input?: string;
  stdout: string;
  stderr?: string;
  action?: "kill" | "dispose" | "kill-detached";
}
const encoder = new TextEncoder();
function uint(value: number): number[] {
  const result: number[] = [];
  do { const byte = value & 127; value >>>= 7; result.push(byte | (value ? 128 : 0)); } while (value);
  return result;
}
function sint(value: number): number[] {
  const result: number[] = [];
  for (;;) {
    const byte = value & 127; value >>= 7;
    const more = value !== ((byte & 64) ? -1 : 0);
    result.push(byte | (more ? 128 : 0)); if (!more) return result;
  }
}
function text(value: string) { const bytes = Array.from(encoder.encode(value)); return uint(bytes.length).concat(bytes); }
function section(id: number, body: number[]) { return [id].concat(uint(body.length), body); }
const constant = (value: number) => [0x41].concat(sint(value));
const get = (local: number) => [0x20].concat(uint(local));
const set = (local: number) => [0x21].concat(uint(local));
const call = (fn: number, ...args: number[][]) => args.flat().concat([0x10], uint(fn));
const load = (pointer: number) => constant(pointer).concat([0x28, 2, 0]);
const check = (expression: number[], expected: number, stage: number) => expression.concat(constant(expected),
  [0x47, 0x04, 0x40], call(4, constant(stage)), [0x00, 0x0b]);
const close = (fd: number[]) => check(call(6, fd), 0, 204);

/** All spawns happen before any wait: pipelines must run concurrently, not buffer in the page. */
export function bunRuntimeProcFixture(scenario: BunRuntimeScenario): Uint8Array<ArrayBuffer> {
  const memory = new Uint8Array(60_000);
  const body: number[] = [];
  if (scenario.pipe) body.push(...check(call(5, constant(128)), 0, 201), ...load(128), ...set(0), ...load(132), ...set(1));
  let pointer = 4096;
  for (const [index, command] of scenario.commands.entries()) {
    const spec: Omit<SpawnRequest, "fds"> & { fds: BunRuntimeCommand["fds"] } = {
      executable: command.executable ?? "/bin/bun", argv: ["bun", "-e", command.source],
      env: { PWD: "/home/user", PATH: "/bin:/usr/bin" }, cwd: "/home/user", job: 0,
      fds: command.fds ?? [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }],
    };
    let json = JSON.stringify(spec);
    for (const [name, local] of [["reader", 0], ["writer", 1]] as const) {
      for (;;) {
        const marker = JSON.stringify(name), start = json.indexOf(marker);
        if (start === -1) break;
        // Ten columns accommodate every legal signed runtime descriptor. Fill right-to-left.
        json = json.slice(0, start) + "          " + json.slice(start + marker.length);
        body.push(...get(local), ...set(2), ...constant(pointer + start + 9), ...set(3), 0x03, 0x40,
          ...get(3), ...get(2), ...constant(10), 0x70, ...constant(48), 0x6a, 0x3a, 0, 0,
          ...get(3), ...constant(1), 0x6b, ...set(3), ...get(2), ...constant(10), 0x6e, 0x22, 2, 0x0d, 0, 0x0b);
      }
    }
    const bytes = encoder.encode(json);
    if (pointer + bytes.length > memory.length) throw new RangeError("external root fixture exceeds one memory page");
    memory.set(bytes, pointer);
    body.push(...call(0, constant(pointer), constant(bytes.length)), ...set(index + 4),
      ...check(get(index + 4).concat(constant(0), [0x48]), 0, 202));
    pointer += bytes.length + 16;
  }
  if (scenario.pipe === "input") {
    const input = encoder.encode(scenario.input ?? ""); memory.set(input, 1024);
    body.push(...check(call(3, get(1), constant(1024), constant(input.length)), input.length, 203));
  }
  if (scenario.pipe === "signal") {
    // Three real generations each publish one R only after their nested spawn was accepted.
    // Readiness is not a read reservation: retain byte checks across AGAIN and short reads.
    body.push(...constant(0), ...set(2), 0x03, 0x40,
      ...call(7, get(0), constant(1024).concat(get(2), [0x6a]), constant(3).concat(get(2), [0x6b])), ...set(3),
      ...get(3), ...constant(-6), 0x46, 0x04, 0x40,
      ...constant(320), ...constant(0), 0x36, 2, 0,
      ...constant(324), ...get(0), 0x36, 2, 0,
      ...constant(328), ...constant(0), 0x36, 2, 0,
      ...constant(332), ...constant(0), 0x36, 2, 0,
      ...call(8, constant(320), constant(1), constant(5000), constant(352)), 0x1a, 0x0c, 1, 0x0b,
      ...check(get(3).concat(constant(0), [0x4c]), 0, 208),
      ...get(2), ...get(3), 0x6a, ...set(2), ...get(2), ...constant(3), 0x49, 0x0d, 0, 0x0b);
    for (let index = 0; index < 3; index++) body.push(...check(constant(1024 + index).concat([0x2d, 0, 0]), 82, 209));
    body.push(...check(call(9, call(1, get(4)), constant(9)), 0, 210));
  }
  if (scenario.pipe) body.push(...close(get(0)), ...close(get(1)));
  for (const [index, command] of scenario.commands.entries()) {
    body.push(...check(call(2, call(1, get(index + 4)), constant(0), constant(256)), 0, 205),
      ...check(load(256), command.status ?? 0, 206));
  }
  const marker = "external-root-ok\n"; memory.set(encoder.encode(marker), 512);
  body.push(...check(call(3, constant(1), constant(512), constant(marker.length)), marker.length, 207));
  const locals = 4 + scenario.commands.length;
  const code = [1].concat(uint(locals), [0x7f], body, [0x0b]);
  const signature = (arity: number, result = true) => [0x60].concat(uint(arity), Array.from({ length: arity }, () => 0x7f), result ? [1, 0x7f] : [0]);
  const imports: [string, string, number][] = [
    ["runtime_proc", "spawn", 1], ["runtime_proc", "job_of", 0], ["runtime_proc", "wait_job", 2],
    ["runtime_proc", "write", 2], ["wasi_snapshot_preview1", "proc_exit", 3],
    ["runtime_proc", "pipe", 0], ["wasi_snapshot_preview1", "fd_close", 0],
    ["runtime_proc", "read", 2], ["runtime_proc", "poll", 5], ["runtime_proc", "kill_job", 1],
  ];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [6].concat(signature(1), signature(2), signature(3), signature(1, false), signature(0, false), signature(4))),
    section(2, uint(imports.length).concat(imports.flatMap(([namespace, name, type]) => text(namespace).concat(text(name), [0], uint(type))))),
    section(3, [1, 4]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, imports.length])),
    section(10, [1].concat(uint(code.length), code)),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(uint(memory.length), Array.from(memory))),
  ));
}

const nested = `const cp=require('node:child_process'); const p=cp.spawn('bun',['-e',"console.log('nested-node');console.error('nested-err')"],{stdio:'inherit'}); await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error('nested exit '+code)))});`;
const childReader = `const f=require('node:fs'),b=Buffer.alloc(7);let n=0;while(n<7){const got=f.readSync(0,b,n,7-n,null);if(!got)throw Error('early EOF');n+=got}console.log(b.toString());`;
const readerLifetime = `const child=Bun.spawn(['bun','-e',${JSON.stringify(childReader)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});if(await child.exited!==0)throw Error('reader child failed');const f=require('node:fs'),b=Buffer.alloc(1);if(f.readSync(0,b,0,1,null)!==1||b[0]!==33)throw Error('parent reader closed');console.log('parent-reader-alive');`;
const readyLeaf = `require('node:fs').writeSync(1,'R');setInterval(()=>{},1000);`;
const readyChild = `const cp=require('node:child_process');cp.spawn('bun',['-e',${JSON.stringify(readyLeaf)}],{stdio:'inherit'});require('node:fs').writeSync(1,'R');setInterval(()=>{},1000);`;
const readyTree = `Bun.spawn(['bun','-e',${JSON.stringify(readyChild)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});require('node:fs').writeSync(1,'R');setInterval(()=>{},1000);`;
const grandchild = `console.log('grandchild-ready');setInterval(()=>{},1000);`;
const childTree = `const cp=require('node:child_process');cp.spawn('bun',['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});console.log('child-ready');setInterval(()=>{},1000);`;
const tree = `Bun.spawn(['bun','-e',${JSON.stringify(childTree)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});console.log('leader-ready');setInterval(()=>{},1000);`;
const detachedLeaf = `console.log('detached-ready');setInterval(()=>{},1000);`;
const detachedTree = `Bun.spawn(['bun','-e',${JSON.stringify(detachedLeaf)}],{detached:true,stdin:'inherit',stdout:'inherit',stderr:'inherit'});${tree}`;
const grandchildNoControls = `if(process.env.BUNWASM_WORKER_CONTROL!==undefined)throw Error('worker control metadata leaked');const f=require('node:fs');for(const fd of [1000,1001]){let code;try{f.fstatSync(fd)}catch(error){code=error.code}if(code!=='EBADF')throw Error('grandchild inherited fd '+fd)}console.log('grandchild-no-controls');`;
const workerHighFds = `const f=require('node:fs'),opened=[];if(process.env.BUNWASM_WORKER_CONTROL!==undefined)throw Error('worker control metadata visible');try{while(opened.length<1100){const fd=f.openSync('/home/user/high-fd-data','w+');opened.push(fd);if(fd>=1001)break}for(const fd of [1000,1001]){if(!opened.includes(fd))throw Error('reserved magic fd '+fd);f.writeSync(fd,'X',0);const b=Buffer.alloc(1);if(f.readSync(fd,b,0,1,0)!==1||b[0]!==88)throw Error('ordinary high fd unusable '+fd)}const child=Bun.spawn(['bun','-e',${JSON.stringify(grandchildNoControls)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});if(await child.exited!==0)throw Error('grandchild fd isolation failed');require('node:worker_threads').parentPort.postMessage('worker-high-fds-ok');}finally{for(const fd of opened)f.closeSync(fd)}require('node:worker_threads').parentPort.close();`;
const workerControls = `const {Worker}=require('node:worker_threads');const worker=new Worker(${JSON.stringify(workerHighFds)},{eval:true});let message;worker.on('message',value=>{message=value});await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(Error('Worker exit '+code)))});if(message!=='worker-high-fds-ok')throw Error('missing Worker control roundtrip');console.log(message);`;
const ordinary = [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }];
const mainScenarios: BunRuntimeScenario[] = [
  { name: "nested", commands: [{ source: `const p=Bun.spawn(['bun','-e',${JSON.stringify(nested)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});if(await p.exited!==0)throw Error('child failed');console.log('nested-ok');` }], stdout: "nested-node\nnested-ok\nexternal-root-ok\n", stderr: "nested-err\n" },
  { name: "pipeline-merged", pipe: "pipeline", commands: [
    { source: `console.log('pipeline-out');console.error('pipeline-err');`, fds: [{ child: 0, parent: 0 }, { child: 1, parent: "writer" }, { child: 2, parent: "writer" }] },
    { source: `const input=await Bun.stdin.text();if(input!=='pipeline-out\\npipeline-err\\n')throw Error(JSON.stringify(input));console.log('pipeline-merged-ok');`, fds: [{ child: 0, parent: "reader" }, { child: 1, parent: 1 }, { child: 2, parent: 2 }] },
  ], stdout: "pipeline-merged-ok\nexternal-root-ok\n" },
  { name: "stdin-reader-lifetime", pipe: "input", input: "payload!", commands: [{ source: readerLifetime, fds: [{ child: 0, parent: "reader" }, { child: 1, parent: 1 }, { child: 2, parent: 2 }] }], stdout: "payload\nparent-reader-alive\nexternal-root-ok\n" },
  { name: "postleader-job-wait", commands: [{ source: `Bun.spawn(['bun','-e',"await Bun.sleep(100);console.log('postleader-child');"],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(0);` }], stdout: "postleader-child\nexternal-root-ok\n" },
  { name: "guest-kill-job-descendants", pipe: "signal", commands: [{ source: readyTree, status: 137,
    fds: [{ child: 0, parent: 0 }, { child: 1, parent: "writer" }, { child: 2, parent: 2 }] }], stdout: "external-root-ok\n" },
  { name: "kill-descendants", commands: [{ source: tree, status: 137 }], action: "kill", stdout: "external-root-ok\n" },
  { name: "detached-excluded-from-foreground-kill", commands: [{ source: detachedTree, status: 137 }], action: "kill-detached", stdout: "external-root-ok\n" },
  { name: "dispose-live-descendants", commands: [{ source: tree }], action: "dispose", stdout: "" },
  { name: "worker-control-fd-isolation", commands: [{ source: workerControls }], stdout: "grandchild-no-controls\nworker-high-fds-ok\nexternal-root-ok\n" },
  { name: "start-failed", commands: [{ executable: "/bin/broken-bun", source: "", status: 126 }], stdout: "external-root-ok\n" },
  { name: "preopen-root", commands: [{ source: `console.log(await Bun.file('preopen-data').text());` }], stdout: "ROOT_PREOPEN_OK\nexternal-root-ok\n" },
];
export const bunRuntimeProcScenarios: readonly BunRuntimeScenario[] = mainScenarios.concat([[3], [3, 4], [3, 5], [3, 1000000]].map<BunRuntimeScenario>(inherited => ({
  name: `preopen-inherited-${inherited.join("-")}`, commands: [{ source: `console.log(await Bun.file('preopen-data').text());`, status: 71,
    fds: ordinary.concat(inherited.map(fd => ({ child: fd, parent: 1 }))) }], stdout: "external-root-ok\n",
})), [{ name: "preopen-blocks-fd4-read-fd3-write", commands: [{ source: `const f=require('node:fs'),b=Buffer.alloc(6);f.readSync(4,b,0,6,null);f.writeSync(3,'FD3:'+b.toString()+'\\n');`, status: 71,
  fds: ordinary.concat([{ child: 3, parent: 1 }, { child: 4, parent: 0 }]) }], stdout: "external-root-ok\n" }]);

// These are guest/libc limitations, not passing substitutes for future successful inheritance.
export const bunRuntimeProcPending = [
  "actual Bun discovers its relocated root with inherited fd3 and exits 0",
  "actual Bun shares inherited fd4 offsets and writes fd3 after preopen discovery",
] as const;
