// Original byte-encoded external shell guest, following runtime-proc-fixtures.ts's ABI layout.
// This is intentionally not a Bun root: only its registered children execute Bun JavaScript.
import type { SpawnRequest } from "waffle/proc/types";

interface BunRuntimeCommand {
  executable?: string;
  source: string;
  fds?: { child: number; parent: number | "reader" | "writer" }[];
  status?: number;
  kind?: 0 | 1 | 2;
}
export interface BunRuntimeScenario {
  name: string;
  commands: BunRuntimeCommand[];
  pipe?: "pipeline" | "input" | "signal";
  input?: string;
  /** Root opens this real file, consumes its prefix, then shares its cursor with the child. */
  fileCursor?: "sequential" | "positioned";
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
// Failure-only diagnostics use the existing scratch locals and preserve the ABI return.
const decimal = (value: number[], end: number) => value.concat(set(2), constant(end), set(3), [0x03, 0x40],
  get(3), get(2), constant(10), [0x70], constant(48), [0x6a, 0x3a, 0, 0],
  get(3), constant(1), [0x6b], set(3), get(2), constant(10), [0x6e, 0x22, 2, 0x0d, 0, 0x0b]);

function encodeDescriptorMarkers(spec: Omit<SpawnRequest, "fds"> & { fds: BunRuntimeCommand["fds"] }, pointer: number, body: number[]) {
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
  return json;
}

/** All spawns happen before any wait: pipelines must run concurrently, not buffer in the page. */
export function bunRuntimeProcFixture(scenario: BunRuntimeScenario): Uint8Array<ArrayBuffer> {
  const memory = new Uint8Array(60_000);
  const body: number[] = [];
  if (scenario.pipe) body.push(...check(call(5, constant(128)), 0, 201), ...load(128), ...set(0), ...load(132), ...set(1));
  if (scenario.fileCursor) {
    const path = encoder.encode("home/user/inherited-cursor"); memory.set(path, 2048);
    // The external root has no inherited extras, so its actual root preopen is fd3.
    // Positioned reads additionally need FD_SEEK; metadata identifies the regular-file path.
    const rights = scenario.fileCursor === "positioned" ? (1 << 21) | 6 : 2;
    // path_open(fd, lookupflags, path, len, oflags, rights, inheriting, fdflags, result).
    body.push(...check(call(10, constant(3), constant(0), constant(2048), constant(path.length), constant(0),
      [0x42].concat(sint(rights)), [0x42, 0], constant(0), constant(128)), 0, 211), ...load(128), ...set(0),
      ...check(call(7, get(0), constant(1024), constant(2)), 2, 212),
      ...check(load(1024).concat(constant(65535), [0x71]), 0x7878, 213));
  }
  let pointer = 4096;
  for (const [index, command] of scenario.commands.entries()) {
    const spec: Omit<SpawnRequest, "fds"> & { fds: BunRuntimeCommand["fds"] } = {
      executable: command.executable ?? "/bin/bun", argv: ["bun", "-e", command.source],
      env: { PWD: "/home/user", PATH: "/bin:/usr/bin" }, cwd: "/home/user", job: 0,
      fds: command.fds ?? [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }],
    };
    const json = encodeDescriptorMarkers(spec, pointer, body);
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
  const waitDiagnostic = "runtime-proc wait_job errno=0000000000 result-kind=0000000000 result-value=0000000000\n";
  memory.set(encoder.encode(waitDiagnostic), 768);
  for (const [index, command] of scenario.commands.entries()) {
    body.push(...constant(384).concat(call(2, call(1, get(index + 4)), constant(0), constant(256)), [0x36, 2, 0],
      load(384), [0x04, 0x40],
      decimal(constant(0).concat(load(384), [0x6b]), 768 + waitDiagnostic.indexOf(" result-kind") - 1),
      decimal(load(256), 768 + waitDiagnostic.indexOf(" result-value") - 1),
      decimal(load(260), 768 + waitDiagnostic.indexOf("\n") - 1),
      call(3, constant(2), constant(768), constant(waitDiagnostic.length)), [0x1a, 0x0b],
      check(load(384), 0, 205), check(load(256), command.kind ?? 0, 206), check(load(260), command.status ?? 0, 206)));
  }
  if (scenario.fileCursor) body.push(...check(call(7, get(0), constant(1024), constant(1)), 1, 214),
    ...check(constant(1024).concat([0x2d, 0, 0]), 33, 215), ...close(get(0)));
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
  if (scenario.fileCursor) imports.push(["wasi_snapshot_preview1", "path_open", 6]);
  const pathOpenSignature = [0x60, 9, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f, 1, 0x7f];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [7].concat(signature(1), signature(2), signature(3), signature(1, false), signature(0, false), signature(4), pathOpenSignature)),
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
const ordinary: NonNullable<BunRuntimeCommand["fds"]> = [{ child: 0, parent: 0 }, { child: 1, parent: 1 }, { child: 2, parent: 2 }];
const mainScenarios: BunRuntimeScenario[] = [
  { name: "nested", commands: [{ source: `const p=Bun.spawn(['bun','-e',${JSON.stringify(nested)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});if(await p.exited!==0)throw Error('child failed');console.log('nested-ok');` }], stdout: "nested-node\nnested-ok\nexternal-root-ok\n", stderr: "nested-err\n" },
  { name: "pipeline-merged", pipe: "pipeline", commands: [
    { source: `console.log('pipeline-out');console.error('pipeline-err');`, fds: [{ child: 0, parent: 0 }, { child: 1, parent: "writer" }, { child: 2, parent: "writer" }] },
    { source: `const input=await Bun.stdin.text();if(input!=='pipeline-out\\npipeline-err\\n')throw Error(JSON.stringify(input));console.log('pipeline-merged-ok');`, fds: [{ child: 0, parent: "reader" }, { child: 1, parent: 1 }, { child: 2, parent: 2 }] },
  ], stdout: "pipeline-merged-ok\nexternal-root-ok\n" },
  { name: "stdin-reader-lifetime", pipe: "input", input: "payload!", commands: [{ source: readerLifetime, fds: [{ child: 0, parent: "reader" }, { child: 1, parent: 1 }, { child: 2, parent: 2 }] }], stdout: "payload\nparent-reader-alive\nexternal-root-ok\n" },
  { name: "readv-process-stdin", pipe: "input", input: "abc", commands: [{
    source: `const f=require('node:fs'),first=Buffer.alloc(4,'.'),tail=new Uint8Array(5).fill(46),views=[first,new DataView(tail.buffer,1,3)];let sync=true;const pending=new Promise((resolve,reject)=>f.readv(0,views,(error,count,buffers)=>{if(error)return reject(error);if(sync||count!==3||buffers!==views||first.toString()!=='abc.'||Buffer.from(tail).toString()!=='.....')return reject(Error('pipe readv scatter/timing'));resolve()}));sync=false;await pending;await new Promise((resolve,reject)=>f.readv(0,views,(error,count,buffers)=>error?reject(error):count===0&&buffers===views&&first.toString()==='abc.'?resolve():reject(Error('pipe readv EOF'))));console.log('readv-stdin-ok');`,
    fds: [{ child: 0, parent: "reader" }, { child: 1, parent: 1 }, { child: 2, parent: 2 }],
  }], stdout: "readv-stdin-ok\nexternal-root-ok\n" },
  { name: "readv-inherited-file-cursor", fileCursor: "positioned", commands: [{
    source: `const f=require('node:fs'),positioned=[Buffer.alloc(2),Buffer.alloc(2)];if(f.readvSync(4,positioned,2)!==4||Buffer.concat(positioned).toString()!=='curs')throw Error('positioned readv');const first=Buffer.alloc(4,'.'),middle=new Uint8Array(4).fill(46),last=Buffer.alloc(2),views=[first.subarray(1,3),new DataView(middle.buffer,1,2),last];await new Promise((resolve,reject)=>f.readv(4,views,(error,count,buffers)=>{if(error)return reject(error);if(count!==6||buffers!==views||first.toString()!=='.cu.'||Buffer.from(middle).toString()!=='.rs.'||last.toString()!=='or')return reject(Error('shared cursor readv'));resolve()}));f.writeSync(3,'readv-file-ok\\n');`,
    fds: ordinary.concat([{ child: 3, parent: 1 }, { child: 4, parent: "reader" }]),
  }], stdout: "readv-file-ok\nexternal-root-ok\n" },
  { name: "postleader-job-wait", commands: [{ source: `Bun.spawn(['bun','-e',"await Bun.sleep(100);console.log('postleader-child');"],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(0);` }], stdout: "postleader-child\nexternal-root-ok\n" },
  { name: "guest-kill-job-descendants", pipe: "signal", commands: [{ source: readyTree, kind: 1, status: 9,
    fds: [{ child: 0, parent: 0 }, { child: 1, parent: "writer" }, { child: 2, parent: 2 }] }], stdout: "external-root-ok\n" },
  { name: "kill-descendants", commands: [{ source: tree, kind: 1, status: 9 }], action: "kill", stdout: "external-root-ok\n" },
  { name: "detached-excluded-from-foreground-kill", commands: [{ source: detachedTree, kind: 1, status: 9 }], action: "kill-detached", stdout: "external-root-ok\n" },
  { name: "dispose-live-descendants", commands: [{ source: tree }], action: "dispose", stdout: "" },
  { name: "worker-control-fd-isolation", commands: [{ source: workerControls }], stdout: "grandchild-no-controls\nworker-high-fds-ok\nexternal-root-ok\n" },
  { name: "inherited-descriptor-semantics", pipe: "input", input: "x", commands: [{
    source: `const f=require('node:fs');const pipe=f.fstatSync(0),terminal=f.fstatSync(3);if(!pipe.isFIFO()||pipe.isFile()||pipe.isCharacterDevice()||pipe.isBlockDevice())throw Error('inherited pipe type');if(!terminal.isCharacterDevice()||terminal.isFile()||terminal.isFIFO()||terminal.isBlockDevice())throw Error('inherited terminal type');for(const run of [()=>f.closeSync(-1),()=>f.closeSync(-7),()=>f.writeSync(1000000,Buffer.alloc(0)),()=>f.writevSync(1000000,[Buffer.alloc(0)]),()=>f.writevSync(1000000,[Buffer.alloc(0),Buffer.alloc(0)])]){let code;try{run()}catch(e){code=e.code}if(code!=='EBADF')throw Error('empty closed descriptor '+code)}if(f.readSync(1000000,Buffer.alloc(0))!==0||f.readSync(1000000,Buffer.alloc(4),0,0,null)!==0)throw Error('empty closed descriptor read');await new Promise((resolve,reject)=>f.read(1000000,Buffer.alloc(0),0,0,null,(error,count)=>error?reject(error):count===0?resolve():reject(Error('empty callback read'))));const handle=await f.promises.open('preopen-data','r');await handle.close();let handleCode;try{await handle.read(Buffer.alloc(0),0,0,null)}catch(error){handleCode=error.code}if(handleCode!=='EBADF')throw Error('closed empty FileHandle read '+handleCode);if(f.readSync(0,Buffer.alloc(0))!==0)throw Error('empty pipe read');const b=Buffer.alloc(1);if(f.readSync(0,b,0,1,null)!==1||b.toString()!=='x')throw Error('empty read consumed pipe');f.writeSync(1,'buffered;');f.writeSync(3,'alias;');f.writeSync(1,'buffered-v;');f.writevSync(3,[Buffer.from('alias-v;')]);f.writeSync(1,'done\\n');`,
    fds: [{ child: 0, parent: "reader" }, { child: 1, parent: 1 }, { child: 2, parent: 2 }, { child: 3, parent: 1 }],
  }], stdout: "buffered;alias;buffered-v;alias-v;done\nexternal-root-ok\n" },
  { name: "start-failed", commands: [{ executable: "/bin/broken-bun", source: "", kind: 2, status: 29 }], stdout: "external-root-ok\n" },
  { name: "preopen-root", commands: [{ source: `console.log(await Bun.file('preopen-data').text());` }], stdout: "ROOT_PREOPEN_OK\nexternal-root-ok\n" },
];
export const bunRuntimeProcScenarios: readonly BunRuntimeScenario[] = mainScenarios.concat([[3], [3, 4], [3, 5], [3, 1000000]].map<BunRuntimeScenario>(inherited => ({
  name: `preopen-inherited-${inherited.join("-")}`,
  commands: [{ source: `console.log(await Bun.file('preopen-data').text());`,
    fds: ordinary.concat(inherited.map(fd => ({ child: fd, parent: 1 }))) }], stdout: "ROOT_PREOPEN_OK\nexternal-root-ok\n",
})), [{ name: "preopen-blocks-fd4-read-fd3-write", fileCursor: "sequential",
  commands: [{ source: `const f=require('node:fs'),b=Buffer.alloc(6);if(f.readSync(4,b,0,6,null)!==6||b.toString()!=='cursor')throw Error('inherited file cursor');if(await Bun.file('preopen-data').text()!=='ROOT_PREOPEN_OK')throw Error('relocated root');f.writeSync(3,'FD3:'+b.toString()+'\\n');`,
  fds: ordinary.concat([{ child: 3, parent: 1 }, { child: 4, parent: "reader" }]) }], stdout: "FD3:cursor\nexternal-root-ok\n" }]);
