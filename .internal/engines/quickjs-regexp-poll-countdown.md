# QuickJS regexp poll countdown restarts on every match

Status: open follow-up, found 2026-11-19 while fixing the same gap in JSC (PR 950).

## Problem

A QuickJS guest stuck in one global `String.prototype.replace`, `split` or `match` that runs many
cheap matches cannot be stopped. `lre_exec` (`third_party/rquickjs-sys/quickjs/libregexp.c`)
starts every call at a fresh `INTERRUPT_COUNTER_INIT` (10,000) countdown, and
`js_regexp_Symbol_replace` / `js_regexp_exec` loop over matches in C without reaching a bytecode
interrupt check. Each match stays under 10,000 steps, so the interrupt handler never runs.

Proof: `runtimeProcess-page-SIGKILL-stops-guest-in-global-regexp-replace` in
`web/tests/engine-interruption-main.ts`. With QuickJS added to `nativeMatchesPollingEngines` in
`web/tests/engine-interruption-cases.ts`, the main-built QuickJS pair fails it on Chromium
("quickjs leftover busy guest unwound after SIGKILL timed out"; `startLeft` 0).

## Tried

Commit f28f0ae1d on branch `t3/jsc-regex-persistent-poll` (reverted in the same PR): a new
`int *lre_interrupt_counter(void *opaque)` hook, defined in `quickjs.c` to return
`&ctx->interrupt_counter` (the bytecode interpreter's own countdown); `lre_exec` loads it, polls
once for the match start, runs `lre_exec_backtrack` and stores the remainder back.

It stops the guest (Chromium, Firefox and WebKit: unwind in 5.5, 5.4 and 8.0 ms, all 39 proofs
green), but the matcher got slower against a same-tree control (native launcher, pinned core,
interleaved, median of 7): `exec` loop +15%, global replace +17%, callback replace +15%, a short
anchored backtracking test +15%. One long single `exec` (`/x/.test("ab".repeat(4e6))`), where
both builds poll identically, was also about 20% slower (84 to 86 ms against 105 ms), so the cost
is code generation in `lre_exec`/`lre_exec_backtrack` (the counter becoming live across the
inlined matcher, or lost inlining), not the extra polls.

## Next

Keep `s->interrupt_counter` a plain local in `lre_exec_backtrack`'s hot loop. Options to measure:
load and store the persistent countdown in `js_regexp_exec` / the replace and split loops in
`quickjs.c` around `lre_exec` (passing it in through `opaque` or a new argument), or tick the
interpreter countdown once per `lre_exec` call there with `js_poll_interrupts(ctx)` and accept
the per-match restart inside `lre_exec`. Check the single-exec scan case first; it must match
the control. Then add QuickJS to `nativeMatchesPollingEngines`.
