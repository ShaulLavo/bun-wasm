import { expect, test } from 'bun:test';
import { sharedBrowserClocks, spiderMonkeyTierOptions, verifySpiderMonkeyQualification, verifySpiderMonkeyStackWitness } from './spidermonkey-native-qualification.ts';

const trace = (polls = '123', entries = '0') => `bun-wasm spidermonkey: stack_low=0x7a0000 stack_high=0xfa0000 stack_bytes=8388608 register_depth=16 entry_depth=1392 interrupt_polls=${polls} portable_baseline_entries=${entries}\n`;
const stopped = 'bun-wasm nested resources: {}\nbun-wasm group before physical stop: GroupSnapshot {}\nbun-wasm group after physical stop: GroupSnapshot { members: 0, reserved: 0, retained: 0, regions: 0, pins: 0, holds: 0, watches: 0, waiters: 0, committed_bytes: 166002688, free_bytes: 165937152, bypassed: false, published: 0 }\n';

test('stack witnesses accept compiler marker placement and reject wrong page inference', () => {
  const host = { type: 'spidermonkey-stack-proof', low: 0x7a0000, high: 0xfa0000, stackBytes: 8 << 20, pointer: 0xfa0000, samePointer: true };
  const hosts = [host, host];
  for (const depth of [16, 24, 65_536]) expect(verifySpiderMonkeyStackWitness(trace().replace('register_depth=16', `register_depth=${depth}`), hosts).registerDepth).toBe(depth);
  for (const depth of [0, 15, 65_537]) expect(() => verifySpiderMonkeyStackWitness(trace().replace('register_depth=16', `register_depth=${depth}`), hosts)).toThrow();
  for (const depth of [0, 15, 8 << 20]) expect(() => verifySpiderMonkeyStackWitness(trace().replace('entry_depth=1392', `entry_depth=${depth}`), hosts)).toThrow();
  expect(() => verifySpiderMonkeyStackWitness(trace(), [host])).toThrow();
  expect(() => verifySpiderMonkeyStackWitness(trace(), [host, { ...host, samePointer: false }])).toThrow();
  expect(() => verifySpiderMonkeyStackWitness(trace().replace('stack_low=0x7a0000 stack_high=0xfa0000', 'stack_low=0x790000 stack_high=0xf90000'), hosts)).toThrow();
  expect(() => verifySpiderMonkeyStackWitness(trace().replace('stack_bytes=8388608', 'stack_bytes=8388607'), hosts)).toThrow();
  expect(() => verifySpiderMonkeyStackWitness(trace().replace('stack_low=0x7a0000', 'stack_low=0x7a0001'), hosts)).toThrow();
});

test('each tier is explicitly selected in both launcher and guest environments', () => {
  const ambient = { BUN_WASM_SPIDERMONKEY_TIER: 'wrong', BUN_WASM_SPIDERMONKEY_TRACE: '0', BUN_WASM_TRACE: '0' };
  for (const tier of ['interp', 'pbl'] as const) {
    const options = spiderMonkeyTierOptions(tier, ambient);
    expect(options.args).toEqual(['--env', `BUN_WASM_SPIDERMONKEY_TIER=${tier}`, '--env', 'BUN_WASM_SPIDERMONKEY_TRACE=1']);
    expect(options.env).toMatchObject({ BUN_WASM_SPIDERMONKEY_TIER: tier, BUN_WASM_SPIDERMONKEY_TRACE: '1', BUN_WASM_TRACE: '1' });
  }
  expect(ambient.BUN_WASM_SPIDERMONKEY_TIER).toBe('wrong');
});

test('plain interpreter proof requires positive polls and zero portable-baseline entries for every observed member', () => {
  const result = verifySpiderMonkeyQualification(trace() + trace('99') + stopped, 'interp');
  expect(result).toMatchObject({ tier: 'interp', returningMembers: 2, interruptPolls: 222, portableBaselineEntries: 0 });
  expect(() => verifySpiderMonkeyQualification(trace() + trace('99', '1') + stopped, 'interp')).toThrow('engagement mismatch');
});

test('portable-baseline proof requires actual entries for every observed member', () => {
  expect(verifySpiderMonkeyQualification(trace('123', '9') + trace('20', '1') + stopped, 'pbl'))
    .toMatchObject({ tier: 'pbl', returningMembers: 2, interruptPolls: 143, portableBaselineEntries: 10 });
  expect(() => verifySpiderMonkeyQualification(trace('123', '9') + trace() + stopped, 'pbl')).toThrow('engagement mismatch');
});

test.each(['', 'selector=pbl elapsed=25\n', 'ordinary stderr\n'])('selectors, time and missing traces do not qualify: %s', stderr => {
  expect(() => verifySpiderMonkeyQualification(stderr + stopped, 'interp')).toThrow('Missing SpiderMonkey');
});

test.each(['-1', 'NaN', '1.5', '4294967296', '9007199254740992'])('invalid counters fail closed: %s', value => {
  expect(() => verifySpiderMonkeyQualification(trace(value) + stopped, 'interp')).toThrow();
  expect(() => verifySpiderMonkeyQualification(trace('12', value) + stopped, 'pbl')).toThrow();
});

test('zero polls and malformed or truncated trace records fail', () => {
  expect(() => verifySpiderMonkeyQualification(trace('0') + stopped, 'interp')).toThrow('positive interrupt polls');
  expect(() => verifySpiderMonkeyQualification(trace('0', '1') + stopped, 'pbl')).toThrow('positive interrupt polls');
  for (const malformed of [trace().replace('portable_baseline_entries=0', ''), 'bun-wasm spidermonkey: interrupted\n', `noise ${trace()}`]) {
    expect(() => verifySpiderMonkeyQualification(trace() + malformed + stopped, 'interp')).toThrow('Malformed');
  }
});

test('unrelated stderr is neither removed nor treated as tier evidence', () => {
  const stderr = 'an intentional trap diagnostic\n' + trace() + stopped + 'another diagnostic\n';
  expect(verifySpiderMonkeyQualification(stderr, 'interp').returningMembers).toBe(1);
  expect(stderr).toStartWith('an intentional trap diagnostic\n');
  expect(stderr).toEndWith('another diagnostic\n');
});

test.each(['members', 'reserved', 'retained', 'regions', 'pins', 'holds', 'watches', 'waiters', 'published'])('the final owner snapshot must release %s', field => {
  expect(() => verifySpiderMonkeyQualification(trace() + stopped.replace(`${field}: 0`, `${field}: 1`), 'interp')).toThrow('remain after final stop');
});

test('missing, duplicate or bypassed accounting cannot qualify', () => {
  expect(() => verifySpiderMonkeyQualification(trace(), 'interp')).toThrow('Missing final');
  expect(() => verifySpiderMonkeyQualification(trace() + stopped.replace('bypassed: false', 'bypassed: true'), 'interp')).toThrow('bypassed');
  expect(() => verifySpiderMonkeyQualification(trace() + stopped.replace('members: 0', 'members: 0, members: 0'), 'interp')).toThrow('Duplicate');
});

test('intermediate live members are allowed but the last snapshot must be empty', () => {
  const live = stopped.replace('members: 0', 'members: 1');
  expect(verifySpiderMonkeyQualification(trace() + live + trace() + stopped, 'interp').finalAccounting.members).toBe('0');
  expect(() => verifySpiderMonkeyQualification(trace() + stopped + trace() + live, 'interp')).toThrow('members remain');
});


test('child traces do not substitute for the final returning member observation', () => {
  expect(() => verifySpiderMonkeyQualification(trace() + stopped + stopped, 'interp')).toThrow('Missing final member tier trace');
});

test('Browser clocks fit completed hosted tiers without changing other entries or engines', () => {
  const measuredMain = 241_523.46;
  const measuredDriver = 280_805.0103;
  const clock = sharedBrowserClocks('spidermonkey');
  expect(clock.pageMs / measuredMain).toBeGreaterThanOrEqual(1.10);
  expect(clock.pageMs / measuredMain).toBeLessThanOrEqual(1.15);
  expect(clock.driverMs / measuredDriver).toBeGreaterThanOrEqual(1.10);
  expect(clock.driverMs / measuredDriver).toBeLessThanOrEqual(1.15);
  expect(clock.consumerSeconds * 1000).toBeGreaterThanOrEqual(clock.driverMs * 2 + 28_000);
  for (const kind of ['quickjs', 'jsc']) expect(sharedBrowserClocks(kind)).toEqual({ pageMs: 240_000, driverMs: 300_000, consumerSeconds: 420 });
  for (const entry of ['spidermonkey-canary.ts', 'spidermonkey-recursion.ts', 'spidermonkey-reentry.ts', 'parser-reserve-ownership.ts', 'failed-stop.ts', 'address-space/guest.ts']) {
    expect(sharedBrowserClocks('spidermonkey', entry).pageMs).toBe(240_000);
  }
});
