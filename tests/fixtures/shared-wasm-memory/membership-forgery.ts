// Public spawn options cannot claim Worker membership. Only a guest with the private spawnWorker
// entry passes this: the older guests still honor a forged _worker option.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { groupOf, memberTag, ownMember } from './page-control.ts';

const child = `${import.meta.dir}/membership-child.ts`;
const root = groupOf(ownMember());

const forged = Bun.spawn([process.execPath, 'run', child, memberTag('forged-bun-spawn')], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', _worker: {} } as never);
assert.notEqual(groupOf('forged-bun-spawn'), root);
forged.stdin.end();
await forged.exited;

const node = spawn(process.execPath, ['run', child, memberTag('forged-child-process')], { stdio: ['pipe', 'ignore', 'ignore'], _worker: {} } as never);
assert.notEqual(groupOf('forged-child-process'), root);
node.stdin!.end();
await new Promise(resolve => node.once('close', resolve));
console.log('shared-wasm-memory membership forgery: pass');
