# Angular diagnostic evidence in the goals runner

Class **Host feature**, **original test adapter**. No upstream code is copied or
adapted. Angular CLI's observed `See "/tmp/ng-…/angular-errors.log" for further
details.` terminal message is the input format.

After an Angular matrix phase has failed, the runner reads only the exact named
guest diagnostic through the existing playground filesystem. It refuses symlinks
at every component and retains the last 16 KiB and at most 100 lines. The read
shares the existing two-second failure-observation allowance with the terminal
snapshot. Missing files and stalled reads cannot change the failed phase or skip
teardown. Both final-log paths preserve the captured diagnostic. No command is
replayed, no assertion changes, and no phase or cleanup deadline increases.
