# Synchronous require recovery

Status: Unit 3 implementation checkpoint, blocked before validation completion.

The adapter stores module generations and bidirectional static import edges.
After a successful link, require snapshots the unevaluated graph. A synchronous
evaluation rejection can retire refusal-only failed candidates and unevaluated
importers if no acquisition or pending holder pins them. It validates the entire
retirement list before changing maps or edges. Retired entries remain allocated
until the last active snapshot exits.

The eight existing adapter control invocations pass on interp and PBL with the
initial implementation. Unit 3 schedules, fault rows, full runtime gates and the
original PBL fixture contrast remain unfinished. The separate recovery control
source is a partial draft and is not wired into the driver.

The planned limit-recovery fixture failed its native Bun expectation generation.
Native Bun 1.4.4 replays a cached RangeError after the recursion fully unwinds.
The reduced graph has a successful-sibling position, a deep dependency and a
cycle. Its body counters remain empty; this proves no counted side effect ran,
not a native body-entry bit. Both fully shallow retries replay the same error.
The design owner must resolve this discrepancy with the approved fixture scope
and native-parity rationale before implementation resumes. No gate was weakened.
