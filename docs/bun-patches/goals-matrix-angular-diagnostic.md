# Angular diagnostic evidence in the goals runner

Class **Host feature**, **original test adapter**. No upstream code is copied or
adapted. Angular CLI's observed `See "/tmp/ng-…/angular-errors.log" for further
details.` terminal message is the input format.

After an Angular matrix phase has failed, the runner reads only the most recently
named guest diagnostic through the existing playground filesystem. A cumulative
terminal can contain older Angular failures; those earlier references must not
replace the newest matching log. A temporary Waffle
client resolves each single path component with final-symlink following disabled.
Resolve responses retain the returned directory and file handles through the read,
so replacing any checked name cannot redirect it. The reader requests at most the
last 16 KiB by file handle and retains at most 100 lines. The read
shares the existing two-second failure-observation allowance with the terminal
snapshot. Missing files and stalled reads cannot change the failed phase or skip
teardown. Both final-log paths preserve the captured diagnostic. No command is
replayed, no assertion changes, and no phase or cleanup deadline increases.

The adapter imports the pinned Waffle client without copying or patching it. Its
browser bundle is injected only during failed-phase evidence capture; portable
fleet runners embed that same bundle. An inner deadline disposes the temporary
client, releases response pins and cancels pending operations. Normal completion
and errors use the same disposal path.
Waffle can reject further resolution from a removed directory. Such a replacement
leaves the diagnostic unavailable; replacing the final file after its stat still
reads the retained original file. Neither case follows the replacement symlink.

The reader now receives a phase-bound transport view. Its existing absolute
observation cutoff also bounds each transport await, including after guest reads.
Browser trap facts captured before the Angular read remain in the fallback if
that optional read expires. No guest reader or filesystem behavior changes.
