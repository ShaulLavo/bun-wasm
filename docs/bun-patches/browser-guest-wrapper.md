# Browser guest wrapper boundary

Classification: original adapter. No upstream implementation is copied or patched.

`scripts/browser-guest-wrapper.ts` adapts the local coverage foundation at
`25cb86e72528a783356ea479a0029da042a019a6` to the scheduled wrapper environment.
It requires an explicit owner, engine subset, browser leg, artifact root and report
root. It verifies the owner's selected closure and supplies the verified serving
root to children. It finalizes the durable ledger on failures and removes private
scratch only after the existing supervisor proves descendant drain.

The source-only controls use synthetic verified sites and owned small children.
They do not qualify guest runtime behavior or replace the original browser drivers.
