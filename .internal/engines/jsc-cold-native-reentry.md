# Cold native reentry on x86 WebKit

Status: Approved for independent structural units. Owner: Engines. This legacy JSC stack-safety item is separate from Unit B and is not dropped.

## Problem and evidence

Linux Playwright WebKit 27.2 with a 512 KiB host stack can trap on cold native reentry before the guest's catchable guard. At a 240 KiB guest budget and 2,048-byte parser reserve, the pre-B donor and B both have steady computed-getter capacity 44 and a caught RangeError at 45. Both also trap at maximum depth in JSON and Proxy controls.

The matched normal .125 donor/B/B/donor comparison recorded 6, 11, 11 and 6 early trapping attempts. All four rows failed the original assertion; these are not passing controls. Each row had its own quiet admission and complete warm history. The first inter-row gap contained a build, and gaps remain a limitation.

Bound calls formerly exercised the C++ executeCall tail during module loading. B removes those unnecessary reentries. A bounded tier diagnostic observed executeCall's optimizing-tier trigger about 1.85 seconds later on B. It did not observe code installation or individual attempt boundaries, and did not measure physical native frames. This supports a warm-up explanation without establishing causation. Equal Wasm locals and shadow bytes do not prove equal physical frames.

Evidence and exact immutable inputs:

- `/work/reports/wave-20261112/engines-active/jsc-low-stack-boundary/RESULT.md`
- `/work/reports/wave-20261112/engines-active/jsc-bound-callback/quiet-comparison/RESULT.md`
- `/work/reports/wave-20261112/engines-active/jsc-bound-callback/tier-diagnostic/RESULT.md`
- `/work/reports/wave-20261112/engines-active/jsc-bound-callback/source-boundary/PARENT-DISPOSITION.md`

The original control is `web/tests/browser-stack.mjs --measure webkit` with ENGINES=jsc, STACK_KIB=240, JSC_PARSER_RESERVE=2048 and `ulimit -s 512`, serving each report's verified whole site. Keep original navigation, probe and assertion limits. The same failure is not inferred for native Safari, physical iPhone, every mode, or P's distinct cold tuple.

## Structural units

Unit 1 routes ordinary JavaScript computed-key getters through the existing C-loop getter
protocol. Unit 2 iterates empty-handler Proxy get forwarding. Unit 3 returns to its tech lead
for a bounded allocation and rooting contract before implementation. The reviewed design and
parent disposition are retained in `/work/reports/goals/stack-exhaustion-20261113/jsc-design/`.

Unit 1 preserves coercion order, primitive receivers, roots, exception position, value profiling,
destination aliases, all three actual operand widths and native fallback paths. Offlineasm's
full expansion assigns private return labels. Check declarations, definitions, references and
semantic return continuations from each real generated split and shared-group product. Never
assign explicit site numbers to preserve earlier private labels.

Keep the 4,896-byte held CLoop frame floor and 328-value-slot gate on finalized sides. Validate
native semantics and embedding, then original Linux WebKit cold and warm computed-getter
controls at 512 KiB host stack, 240 KiB guest budget and 2,048 parser reserve, at 45 and 200000.
Run Chrome too. The expected roughly 39930 frame-stack depth is a measurement, not a cap.
Desktop Safari and iPhone consume the normal merged delivery through the final Safari lane.
Do not add artificial warm-up or change caps, guard budgets or deadlines to hide the failure.

Each independently reviewed green unit merges when ready. Other units and J11 own separate
hunks in the same WebKit patch. Resolve later conflicts through rebase and repeat affected
checks. No reserved merge order or merge hold applies.

Validate a fix against the pre-feature donor and current candidate, including cold/warm and actual platform acceptance, with original assertions intact. Preserve all historical failed controls.

## Unit 3: iterative plain JSON fast path

The WASI fast stringifier owns rooted, fallible container frames instead of recursing through native object and array calls. Frames grow geometrically and publish no more than 4095 containers. The nesting cap and either vector allocation refusal restart the existing general stringifier from the root. That fallback remains authoritative for cycles and the unchanged 40000-holder limit.

Every published container and acquired property table is a live root until its frame pops or the attempt ends. Collection is never deferred. Resumable property enumeration stores the next physical cursor by frame index, never a frame pointer across vector growth. The original output order, stack reservations, soft guard, and 200000-deep caught-error fixture stay unchanged.

The runtime-owned controls exercise real growth refusal, collection before and after frame publication, cleared structure caches, resumed parent frames, and recovery after roots unregister. Split and shared finalized products, all-engine differential fixtures, and the original Linux browser controls qualify the change. Safari remains coordinated through the existing Mac lane.

## Unit B disposition

Managing's decision permits comparative legacy disposition plus real acceptance without fixing this broader item first. PR 685 additionally requires one normal desktop Safari SolidStart/JSC acceptance on a matched delivery showing benefit without regression. If that run establishes no benefit, close PR 685 with a one-line reason. No further B diagnostics are scheduled now. This does not itself approve or merge B.
