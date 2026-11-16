# Matcher cases reached after Set stress completes

Status: Approved. Run as a separate current-main matcher unit after the assigned
11-name repair. These cases were not executed by the earlier incomplete census.
They are observed failures, not independent bug counts or credited improvements.

The first local candidate `71eee74a306bbaee39007491935d811cf65516ec` completes the
unchanged expect file on QuickJS and JSC with 370 pass, 52 fail, 2 todo, and 1 error.
The file remains Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`.
The report is `/work/reports/wave-20261116/engines/matchers-current-push/`.
Its `final/` raw logs and `newly-reached-first-failures.json` retain the first
observed names, log lines, and upstream source pointers.

Reproduce with locally built current-main programs using the maintained
`scripts/bun-suite.py` adapter in that report's `census.py`. Source `env.sh`, use
one worker and the unchanged 600-second file watchdog and 10,000 ms default test
timeout, and keep explicit upstream overrides and `CI=1`. The full group is
`js/bun/test/{bun_test.test.ts,expect-formdata-tojson-crash.test.ts,expect-label.test.ts,expect.test.js}`.
The captured per-file command JSON records actual engine registration, source,
launcher, arguments, and environments. Build instructions are `build.sh` and
`compile.sh`; later candidates reuse only this task's own native prerequisites.
Do not use CI binaries or rewrite upstream assertions.

Start by classifying each case against native Bun and the bounded awaited
comparison contract in PR 866. Promise modifiers intentionally return a Promise
in this adapter; native synchronous-return assertions do not authorize changing
that contract. Runner assertion counts and invocation state belong to the runner
unit. The matcher table, CloseToMatcher, compareAsymmetric, lookupProperty, and
Bun property comparison helpers are useful source entry points for the remaining
cases. Inspect the actual errors before deciding whether names share a root.
Missing asymmetric factories and numeric validation need their native behavior
qualified before implementation. No new public matching API is designed here.

First observed QuickJS failure keys follow. The final report records all engines
and distinguishes retained failures from newly completed coverage.

- `expect() > toEqual objects and arrays` — `test/js/bun/test/expect.test.js:1690:19`, raw log line 86.
- `expect() > toEqual detached ArrayBuffer is not equal to a zero-length ArrayBuffer` — `test/js/bun/test/expect.test.js:1690:19`, raw log line 89.
- `expect() > symbol based keys in arrays are processed correctly` — `test/js/bun/test/expect.test.js:1868:25`, raw log line 102.
- `expect() > are not equal if circularity is not on the same property` — `test/js/bun/test/expect.test.js:2000:19`, raw log line 127.
- `expect() > toHaveProperty() - dot and bracket notation edge cases` — `test/js/bun/test/expect.test.js:2136:26`, raw log line 146.
- `expect() > toHaveLength() extended` — `test/js/bun/test/expect.test.js:2475:29`, raw log line 165.
- `expect() > toContainAllKeys` — `test/js/bun/test/expect.test.js:2714:40`, raw log line 403.
- `expect() > toContainValue` — `test/js/bun/test/expect.test.js:2801:21`, raw log line 415.
- `expect() > toContainValues` — `test/js/bun/test/expect.test.js:2830:21`, raw log line 425.
- `expect() > toContainAllValues` — `test/js/bun/test/expect.test.js:2869:15`, raw log line 435.
- `expect() > toContainAnyValues` — `test/js/bun/test/expect.test.js:2913:15`, raw log line 445.
- `expect() > toMatchObject > with Bun.deepMatch` — `test/js/bun/test/expect.test.js:3464:57`, raw log line 468.
- `expect() > toMatchObject > with expect matcher` — `test/js/bun/test/expect.test.js:3490:39`, raw log line 481.
- `expect() > toBeEmptyObject()` — `test/js/bun/test/expect.test.js:3893:39`, raw log line 527.
- `expect() > toBeObject()` — `test/js/bun/test/expect.test.js:4024:24`, raw log line 547.
- `expect() > asymmetric matchers > expect.any(Object) matches typeof === 'object'` — `test/js/bun/test/expect.test.js:4198:20`, raw log line 575.
- `expect() > asymmetric matchers > expect.any on primitive wrapper classes` — `test/js/bun/test/expect.test.js:4237:34`, raw log line 589.
- `expect() > asymmetric matchers > expect.not.any is the complement of expect.any for primitives` — `test/js/bun/test/expect.test.js:4298:42`, raw log line 600.
- `expect() > asymmetric matchers > expect.not.any with user class` — `test/js/bun/test/expect.test.js:4329:52`, raw log line 610.
- `expect() > asymmetric matchers > ObjectContaining does not match` — `test/js/bun/test/expect.test.js:4443:63`, raw log line 632.
- `expect() > asymmetric matchers > ObjectNotContaining matches` — `test/js/bun/test/expect.test.js:4491:61`, raw log line 650.
- `expect() > asymmetric matchers > ObjectNotContaining throws for non-objects` — `test/js/bun/test/expect.test.js:4559:10`, raw log line 666.
- `expect() > asymmetric matchers > StringNotContaining throws if expected value is not string` — `test/js/bun/test/expect.test.js:4587:10`, raw log line 684.
- `expect() > asymmetric matchers > closeTo > 0 notCloseTo 0 return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 705.
- `expect() > asymmetric matchers > closeTo > 0 notCloseTo 0.001 return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 716.
- `expect() > asymmetric matchers > closeTo > 1.23 notCloseTo 1.229 return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 727.
- `expect() > asymmetric matchers > closeTo > 1.23 notCloseTo 1.226 return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 738.
- `expect() > asymmetric matchers > closeTo > 1.23 notCloseTo 1.225 return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 749.
- `expect() > asymmetric matchers > closeTo > 1.23 notCloseTo 1.234 return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 760.
- `expect() > asymmetric matchers > closeTo > Infinity notCloseTo Infinity return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 771.
- `expect() > asymmetric matchers > closeTo > -Infinity notCloseTo -Infinity return false` — `test/js/bun/test/expect.test.js:4655:29`, raw log line 782.
- `expect() > asymmetric matchers > closeTo > 0 notCloseTo 0.01 return true` — `test/js/bun/test/expect.test.js:4671:29`, raw log line 793.
- `expect() > asymmetric matchers > closeTo > 1 notCloseTo 1.23 return true` — `test/js/bun/test/expect.test.js:4671:29`, raw log line 804.
- `expect() > asymmetric matchers > closeTo > 1.23 notCloseTo 1.2249999 return true` — `test/js/bun/test/expect.test.js:4671:29`, raw log line 815.
- `expect() > asymmetric matchers > closeTo > Infinity notCloseTo -Infinity return true` — `test/js/bun/test/expect.test.js:4671:29`, raw log line 826.
- `expect() > asymmetric matchers > closeTo > Infinity notCloseTo 1.23 return true` — `test/js/bun/test/expect.test.js:4671:29`, raw log line 837.
- `expect() > asymmetric matchers > closeTo > -Infinity notCloseTo -1.23 return true` — `test/js/bun/test/expect.test.js:4671:29`, raw log line 848.
- `expect() > asymmetric matchers > closeTo > 0 notCloseTo 0.1 with precision 0 return false` — `test/js/bun/test/expect.test.js:4685:29`, raw log line 859.
- `expect() > asymmetric matchers > closeTo > 0 notCloseTo 0.0001 with precision 3 return false` — `test/js/bun/test/expect.test.js:4685:29`, raw log line 870.
- `expect() > asymmetric matchers > closeTo > 0 notCloseTo 0.000004 with precision 5 return false` — `test/js/bun/test/expect.test.js:4685:29`, raw log line 881.
- `expect() > asymmetric matchers > closeTo > 2.0000002 notCloseTo 2 with precision 5 return false` — `test/js/bun/test/expect.test.js:4685:29`, raw log line 892.
- `expect() > asymmetric matchers > closeTo > 3.141592e-7 notCloseTo 3e-7 with precision 8 return true` — `test/js/bun/test/expect.test.js:4697:29`, raw log line 903.
- `expect() > asymmetric matchers > closeTo > 56789 notCloseTo 51234 with precision -4 return true` — `test/js/bun/test/expect.test.js:4697:29`, raw log line 914.
- `expect() > asymmetric matchers > closeTo > closeTo throw if expected is not number` — `test/js/bun/test/expect.test.js:4705:12`, raw log line 928.
- `expect() > asymmetric matchers > closeTo > closeTo throw if precision is not number` — `test/js/bun/test/expect.test.js:4723:12`, raw log line 943.
- `expect() > asymmetric matchers > closeTo > notCloseTo return false if received is not number` — `test/js/bun/test/expect.test.js:4738:27`, raw log line 955.
- `expect() > async asymmetric matching > expect.rejectsTo` — `test/js/bun/test/expect.test.js:4746:51`, raw log line 965.
- `expect() > async asymmetric matching > expect.resolvesTo` — `test/js/bun/test/expect.test.js:4767:52`, raw log line 975.
- `expect() > async asymmetric matching > expect.resolvesTo.any and expect.rejectsTo.any match primitives by constructor type` — `test/js/bun/test/expect.test.js:4792:52`, raw log line 985.
- `expect() > expect.assertions doesn't throw when valid, async` — `test/js/bun/test/expect.test.js:4792:52`, raw log line 1003.
- `expect() > rejects to return undefined` — `test/js/bun/test/expect.test.js:4935:67`, raw log line 1023.
- `expect() > resolves to return undefined` — `test/js/bun/test/expect.test.js:4938:57`, raw log line 1036.
