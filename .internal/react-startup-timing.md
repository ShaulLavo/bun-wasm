# React startup timing

Status: Approved. Implementation ready for independent review. Merge is held.

Measure the real React template through its rendered preview and working counter.
Record explicit cold and warm browser cache conditions in JSON. Compare the current
and previous deployments on the same browser and host before changing runtime code.
Keep timing evidence in /work/reports/goals/react-startup/IMPLEMENTATION.md.

The bounded implementation lane owns the timing runner, its regression checks, and
a demonstrated root-cause fix. The coordinator owns deployment history, review,
merge, and publication.

Both unmodified historical arms reproduced an output-only stdin EOF shutdown, not
a 20 times startup regression. The focused environment fix keeps the development
server alive. A same-host corrected comparison completed all visible render and
counter assertions. The original user slowdown remains unconfirmed.

The optional goals hook has real failing-HTTP CI coverage and a passing real-app
integration run. The deployment/goals coordinator must activate it in the next
maintained PC campaign. Existing scheduled campaigns do not pass the new flag.
Do not claim that recurring production timing protection is already active.

Managing must explicitly release the merge after React Router PR 539 lands because
this change shares scripts/goals-matrix. No merge or deployment belongs to this
implementation worker.
