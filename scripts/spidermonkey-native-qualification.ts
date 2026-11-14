import assert from 'node:assert/strict';

export const spiderMonkeyTiers = ['interp', 'pbl'] as const;
export type SpiderMonkeyTier = typeof spiderMonkeyTiers[number];

/** Generous hang caps; correctness is determined by the fixture output and ownership checks. */
export function sharedBrowserClocks(kind: string, entry = "browser-guest.ts") {
  const spiderMonkey = kind === "spidermonkey";
  return {
    pageMs: spiderMonkey && entry === "browser-guest.ts" ? 480_000 : 240_000,
    driverMs: spiderMonkey ? 540_000 : 300_000,
    consumerSeconds: spiderMonkey ? 1320 : 420,
  };
}

/** Marker offsets may change with Rust layout; host observations independently bind the carved stack. */
export function verifySpiderMonkeyStackWitness(stderr: string, hostStacks: readonly unknown[]) {
  const match = /stack_low=(0x[\da-f]+) stack_high=(0x[\da-f]+) stack_bytes=(\d+) register_depth=(\d+) entry_depth=(\d+) interrupt_polls=(\d+) portable_baseline_entries=(\d+)/.exec(stderr);
  assert(match, 'Missing actual SpiderMonkey execution counters');
  const layout = { low: Number(match[1]), high: Number(match[2]), stackBytes: Number(match[3]),
    registerDepth: Number(match[4]), entryDepth: Number(match[5]), polls: Number(match[6]), entries: Number(match[7]) };
  assert(Object.values(layout).every(Number.isSafeInteger), 'Invalid SpiderMonkey stack witness');
  assert(layout.low >= 0 && layout.high > layout.low);
  assert.equal(layout.low % 65_536, 0);
  assert.equal(layout.high % 65_536, 0);
  assert.equal(layout.stackBytes, 8 << 20);
  assert.equal(layout.high - layout.low, layout.stackBytes);
  assert(layout.registerDepth >= 16 && layout.registerDepth <= 65_536, 'Registration marker must fit in the top stack page');
  assert(layout.entryDepth >= 16 && layout.entryDepth < layout.stackBytes, 'Entry marker must fit inside the member stack');
  assert(hostStacks.length >= 2, 'Core and side imports were not observed');
  for (const stack of hostStacks) assert.deepEqual(stack, { type: 'spidermonkey-stack-proof', low: layout.low, high: layout.high,
    stackBytes: layout.stackBytes, pointer: layout.high, samePointer: true });
  return layout;
}

export function spiderMonkeyTierOptions(tier: SpiderMonkeyTier, env: NodeJS.ProcessEnv) {
  const selection = `BUN_WASM_SPIDERMONKEY_TIER=${tier}`;
  return {
    args: ['--env', selection, '--env', 'BUN_WASM_SPIDERMONKEY_TRACE=1'],
    env: { ...env, BUN_WASM_SPIDERMONKEY_TIER: tier, BUN_WASM_SPIDERMONKEY_TRACE: '1', BUN_WASM_TRACE: '1' },
  };
}

function tierCounts(line: string, tier: SpiderMonkeyTier) {
  const match = /^bun-wasm spidermonkey: stack_low=0x[0-9a-f]+ stack_high=0x[0-9a-f]+ stack_bytes=[0-9]+ register_depth=[0-9]+ entry_depth=[0-9]+ interrupt_polls=([0-9]+) portable_baseline_entries=([0-9]+)$/.exec(line);
  assert(match, 'Malformed SpiderMonkey tier trace');
  const polls = Number(match[1]);
  const entries = Number(match[2]);
  assert(Number.isInteger(polls) && polls > 0 && polls <= 0xffff_ffff, 'SpiderMonkey tier trace needs positive interrupt polls');
  assert(Number.isInteger(entries) && entries >= 0 && entries <= 0xffff_ffff, 'Invalid SpiderMonkey entry count');
  assert(tier === 'interp' ? entries === 0 : entries > 0, `SpiderMonkey ${tier} tier engagement mismatch`);
  return { interruptPolls: polls, portableBaselineEntries: entries };
}

function finalAccounting(lines: readonly string[]) {
  const prefix = 'bun-wasm group after physical stop: ';
  const index = lines.findLastIndex(line => line.startsWith(prefix));
  const last = lines[index];
  assert(last, 'Missing final shared-group accounting');
  assert(lines[index - 1]?.startsWith('bun-wasm group before physical stop: ')
    && lines[index - 2]?.startsWith('bun-wasm nested resources: ')
    && lines[index - 3]?.startsWith('bun-wasm spidermonkey:'), 'Missing final member tier trace before owner settlement');
  assert(last.startsWith(`${prefix}GroupSnapshot { `) && last.endsWith(' }'), 'Malformed final shared-group accounting');
  const fields = last.slice(`${prefix}GroupSnapshot { `.length, -2).split(', ');
  const counters = new Map(fields.map(field => {
    const pair = /^([a-z_]+): ([0-9]+|true|false)$/.exec(field);
    assert(pair, 'Malformed shared-group accounting field');
    return [pair[1]!, pair[2]!] as const;
  }));
  assert(counters.size === fields.length, 'Duplicate shared-group accounting field');
  for (const field of ['members', 'reserved', 'retained', 'regions', 'pins', 'holds', 'watches', 'waiters', 'published']) {
    assert.equal(counters.get(field), '0', `Shared-group ${field} remain after final stop`);
  }
  assert.equal(counters.get('bypassed'), 'false', 'Shared-group accounting was bypassed');
  return Object.fromEntries(counters);
}

/** Inspect known observations without deleting or rewriting any stderr, including intentional traps. */
export function verifySpiderMonkeyQualification(stderr: string, tier: SpiderMonkeyTier) {
  const lines = stderr.split('\n');
  const traces = lines.filter(line => line.includes('bun-wasm spidermonkey:'));
  assert(traces.length > 0, 'Missing SpiderMonkey tier-engagement trace');
  const counts = traces.map(line => tierCounts(line, tier));
  return {
    tier, returningMembers: counts.length,
    interruptPolls: counts.reduce((sum, count) => sum + count.interruptPolls, 0),
    portableBaselineEntries: counts.reduce((sum, count) => sum + count.portableBaselineEntries, 0),
    finalAccounting: finalAccounting(lines),
  };
}
