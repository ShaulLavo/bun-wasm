# QuickJS regexp poll countdown restarts on every match

Status: fixed on branch `t3/quickjs-regexp-stop` (2026-11-20). Found 2026-11-19 while fixing the
same gap in JSC (PR 950).

## Problem

A QuickJS guest stuck in one global `String.prototype.replace`, `split` or `match` that runs many
cheap matches cannot be stopped. `lre_exec` (`third_party/rquickjs-sys/quickjs/libregexp.c`)
starts every call at a fresh `INTERRUPT_COUNTER_INIT` (10,000) countdown, and
`js_regexp_Symbol_replace` / `js_regexp_exec` loop over matches in C without reaching a bytecode
interrupt check. Each match stays under 10,000 steps, so the interrupt handler never runs.

## Tried

Commit f28f0ae1d on branch `t3/jsc-regex-persistent-poll` (reverted in the same PR) carried the
interpreter's countdown into `lre_exec`. It stopped the guest, but the matcher got 15 to 20%
slower, even on one long `exec` where both builds poll identically.

## Fix

`libregexp.c` is unchanged. `js_regexp_exec_internal` and `JS_RegExpDelete` in `quickjs.c` (the
only `lre_exec` callers) charge each match attempt 100 steps of the interpreter's countdown
(`js_regexp_poll_interrupts`), so at most 100 attempts of under 10,000 matcher steps each run
between polls. Proofs: `scripts/quickjs-regexp-test.test.ts` (replace, empty replace, split,
matchAll spread) and QuickJS in `nativeMatchesPollingEngines`. Measurements are in the PR.
