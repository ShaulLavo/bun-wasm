// Who owns the JSC parser reserve inside one memory group (docs/stack-limits.md). Each case is its
// own group: a parent process with one value and its Worker child. The parent measures itself,
// runs the child, and measures itself again. The Browser harness asserts on the records
// (web/tests/parser-reserve-ownership.ts); this guest only produces them.
import { spawn } from 'node:child_process';

const RESERVE = 'BUN_WASM_JSC_PARSER_RESERVE';
const probe = `${import.meta.dir}/stack-depth.js`;
interface Case { readonly name: string; readonly parent: string; readonly child?: Record<string, string | null> }
// Reduced values stay at 1024 and above, at the smallest browser budget: nesting no deeper than
// every browser already parses at its own budget (docs/stack-limits.md).
const cases: Case[] = [
  { name: 'explicit', parent: '1536', child: { [RESERVE]: '1024' } },
  { name: 'default-child', parent: '1024', child: { [RESERVE]: null } },
  { name: 'inherited', parent: '1536' },
  { name: 'same-value', parent: '2048', child: { [RESERVE]: '1536' } },
];

function group(entry: Case): Promise<{ code: number | null; output: string }> {
  const worker = entry.child ? { STACK_DEPTH_WORKER_ENV: JSON.stringify(entry.child) } : {};
  const env = { ...process.env, BUN_WASM_STACK_KIB: '192', [RESERVE]: entry.parent, ...worker };
  return new Promise((resolve, reject) => {
    const parent = spawn(process.execPath, [probe, 'chainWorker', '4096'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    parent.stdout.on('data', (chunk) => { output += chunk; });
    parent.on('error', reject);
    parent.on('close', (code) => resolve({ code, output }));
  });
}

for (const entry of cases) {
  const { code, output } = await group(entry);
  console.log(`ownership-case ${JSON.stringify({ name: entry.name, code, output: encodeURIComponent(output) })}`);
}
console.log('parser reserve ownership: recorded');
