# Native report server readiness

Classification: original local adapter. No upstream source is copied or patched.

`scripts/goals-matrix/native-ready.ts` observes a native report controller's local
log, optional error marker, and queue-exit marker. It installs directory watchers
before reading current state, so a ready record already present or written during
observer installation needs no later notification. Incomplete JSON remains pending
until a complete record appears. Error and nonempty exit markers take precedence
over ready records. Watcher errors and unreadable files fail the wait.

Native report controllers use this CLI instead of task-local `fs.watch` waiters:

```sh
bun scripts/goals-matrix/native-ready.ts --log-file /path/to/queue.log --exit-file /path/to/queue.exit --timeout-ms 120000
```

Add `--error-file /path/to/server.error` if the controller writes an error marker.
The CLI prints the complete server JSON record. Its output contains private
control information and belongs only in the controller's private handoff.
The timeout bounds this observation only. Admission, workload, product clocks,
queue ownership, and native cleanup are unchanged. SIGINT and SIGTERM cancel the
wait. Every outcome closes all installed watchers and removes the deadline timer
and abort listener through the existing lifetime helpers.

`checks/quality-goals-matrix-native-ready.json` owns local file race and resource
cleanup regressions under the existing blocking quality gate. No native workload
or device session is required.
