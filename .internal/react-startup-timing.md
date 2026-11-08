# React startup timing

Status: Approved. Implementation in progress.

Measure the real React template through its rendered preview and working counter.
Record explicit cold and warm browser cache conditions in JSON. Compare the current
and previous deployments on the same browser and host before changing runtime code.
Keep timing evidence in /work/reports/goals/react-startup/IMPLEMENTATION.md.

The bounded implementation lane owns the timing runner, its regression checks, and
a demonstrated root-cause fix. The coordinator owns deployment history, review,
merge, and publication.
