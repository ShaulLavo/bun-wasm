# Visible iPhone goals runner

Class **Host feature**, **original test adapter**. No upstream implementation is
copied. The adapter lives in `scripts/goals-matrix/iphone-*.ts`.

The matrix's SafariDriver tab is unsuitable for real XCTest input. The test adapter
uses an ordinary Safari owner page with an actual framework iframe. It injects a
small command observer into the test HTML through the existing preview-origin
binding, without changing the application bundles or guest bytes. The observer
retains the actual preview URL and document time origin across file edits.
The time origin is captured once when the observer starts. Safari's repeated
`performance.timeOrigin` reads varied by milliseconds in the native control;
the immutable observer nonce and retained target identify the same document.

The native click path arms a trusted-event observer on the actual enabled button,
finds its unique visible accessibility reference, and invokes the exact bound
`agent-device` command returned by T3 `device_open`. A successful command alone
cannot pass. The same button in the same document must receive a trusted click,
and its counter must change from zero to one. Other browser transports keep their
existing click implementation.

The owner focuses each new preview iframe after its document loads. Native iOS
input can otherwise end in a trusted `touchcancel` without reaching the counter,
even when the accessibility target and coordinates are correct. A native control
kept the unfocused counter at zero and incremented the focused counter with one
trusted tap. Focus does not dispatch a click, retry input, or change a deadline.
Chromium and WebKit controls verify that a new preview takes focus from the owner
editor and still closes normally. Opening the preview waits for that load and
focus callback, so a load-blocking resource cannot race the single native press.
The child document's `hasFocus()` is not a readiness predicate: native iPhone
Safari can report false with an enabled counter and the parent iframe active.
Controls preserve that false value while proving load ordering and native arming.

The wait for that load does not occupy the owner's observer. Each page runs one
command at a time, so a presentation command that awaited the frame's load event
left the owner unable to answer terminal or diagnostic reads whenever a preview
never finished loading. A native SvelteKit run on JSC reached that state: its
render phase expired with the preview configured but never attached, and the final
terminal read was refused as already pending. The presentation command now inserts
the frame and returns. The frame's own load listener focuses it and records that on
the frame element, so the record is discarded with the frame. Opening then waits
under one deadline, in three stages of short reads: the preview observer attaches
and is visible, the preview document reports `readyState` complete through
read-only observations in the preview role, and cached owner state confirms the
frame's focus record. Regular owner polls publish that record with a fresh
presentation identity. The controller never enqueues an owner command to confirm
focus, so cancellation there cannot block failure-time terminal reads. A record
from an earlier presentation cannot admit input. No read starts after the deadline, after cleanup begins, or after the
presentation changes, and an expiry names its stage and last observation. The
transport accepts native input only between a completed opening and the next
presentation change, so an expired or cancelled opening cannot arm or press even
when the frame loads later. Chromium and WebKit controls hold the
preview navigation and a load-blocking image, read the owner repeatedly meanwhile,
expire and close a held opening, and check that a late load brings no input.

Native arming reports a missing or disabled SSR counter as pending until its
hydration enables the button. The transport polls that state within the original
click phase deadline before taking a native snapshot or pressing once. A ready
counter must still start at zero, be visible and hittable, and retain the same
trusted event, target, URL, time origin and nonce checks. Hydration never grants
a second tap or a new deadline. Focused controls cover disabled-to-enabled
observation, a counter that never enables, and exactly one native press.

Each owner tab receives a unique test title for selective native cleanup. The Mac
wrapper checks availability, owns the normal Mac lock, refuses an existing
SafariDriver process, and records server and lock cleanup. Device command failure
stops further device interactions and the matrix, preserving the failed attempt.

The test server adds COEP and CORP only when absent on instrumented HTML so the
real preview can be framed by the isolated owner. Explicit policies are preserved.
For service-worker previews, the test delivery prefixes the unchanged `sw.js`
with a response observer. It injects only the currently configured navigation
response. The integration control builds the actual `web/src/sw.ts`, forwards
its real preview protocol, and verifies no preview HTML reaches the HTTP server.
Compressed or oversized HTML is rejected. These observation changes and native
command evidence remain test artifacts, separate from the original host inventory.
For the configured root-preview navigation, the test server requests identity
encoding upstream so production compression cannot hide the HTML from this
observer. Other requests retain their original headers. A server that ignores
identity negotiation and returns encoded HTML is still rejected. The original
HTML size limit, content policies and native input predicates are unchanged.
Install, rendering, interaction, hot reload, build, preview, and cleanup retain
their existing matrix deadlines.
Native cleanup shares one deadline and abort signal across all actions, reaps any
active command before proceeding, and cannot start later input after expiry.
Failed iPhone cleanup stops the campaign before another cell starts.

Native tab cleanup uses the documented agent-device batch JSON command to pair
each All Tabs or Close input with its resulting snapshot. It makes three CLI
round trips instead of five, under the same shared 10-second deadline. Each
request contains at most one input because cancellation does not prove native
work stopped. Close must belong to the unique task-title node in the native
snapshot hierarchy. The final snapshot must show that title gone, exactly one
fewer tab, and the other visible tab titles preserved.

Native cleanup closes the unique owned Safari tab without evaluating through the
application observer. A phase timeout can leave an observation pending, so asking
that same observer to remove the preview or stop the shell cannot establish
cleanup. Closing the owner tab ends its dedicated guest workers and embedded
preview. A fresh native accessibility snapshot must confirm the task title is
absent before cleanup passes. Other transports keep their existing scripted
cleanup. The native close still shares the original ten-second inner allowance.

The executor saves a final terminal log before native teardown. Its observation
is bounded separately, and a stalled observer produces a labelled diagnostic log
with the last completed command transcript when available. A log failure cannot
skip resource teardown. Log capture and native close remain within the existing
twenty-second outer cleanup bound.

Every phase and observation now carries a finite admission. Closing it stops new
polls, role switches, preview stages and native input, including after an awaited
step. An already dispatched device command remains owned until its child exits
and is reaped; teardown stays unguarded.

Each observer role reserves its send turn synchronously and permits one reserved
waiter. Failure and final transcript reads join the exact outstanding request
within their original absolute observation deadline. Expired waiters never send
later. The existing execute response certifies settlement of an accepted request,
including ordinary expression errors. Network failures, malformed responses and
uncertified errors leave the role unavailable until teardown rather than guessing
that its bus slot is idle.

The controller, bus and page carry the same absolute `deliverByMs` cutoff, using
their existing `Date.now()` clock convention. The bus rejects expired arrivals and
withdraws undelivered work. The page checks again immediately before evaluation,
since selecting a poll response does not prove page receipt. Expired receipt sends
one ordinary negative reply. Preview reload preserves the cutoff and immediately
settles an observation made undelivered after it expired. Hard request lifetimes,
origin, nonce, time-origin and reply-order checks remain unchanged. There is no
input replay, retry, cancellation route or recovery from permanently stuck page
JavaScript. Chromium and WebKit controls cover the normal short-read race,
undelivered expiry, delayed receipt, natural handoff and unavailable outcomes.
