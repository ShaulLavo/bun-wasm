# Check a prepared deployment on iPhone Safari

Run this manual check before declaring a sandbox deployment complete. It checks
Vite React with Browser, Hono with Browser, and Vite React with QuickJS, in that
order. Each case must start, install dependencies, start its dev server, render
the expected heading, and increment its counter through a trusted native tap.
This smoke does not check hot reload, production build, or production preview.
Its result is separate from the [full goals matrix](../goals-matrix.md).

## Prepare the inputs

Build the playground locally on the PC through the heavy runner from the commit
you want to check. A local prepared root is valid. You do not need CI artifacts,
delivery receipts, or a goals-site inventory. The root must contain `index.html`,
`engine-builds.json`, and the engine files selected by the frontend's common
`templateProfile` helper for each case. Browser cases use ordinary assets; Vite
React on QuickJS uses the shared-group core, engine and transport. The root must
contain both sets, with their fingerprints in the built host and manifest. An
ordinary QuickJS build does not substitute for missing shared-group assets.
The runner checks the
embedded host fingerprints against the guest bytes to catch mixed builds.
The [goals-matrix guide](../goals-matrix.md) describes engine staging and preparation.
Run the smoke command from the selected revision's checkout so preflight reads
the same runtime sources used for its local build. Queue commands such as claim
and complete use the installed watcher's checkout.

Record the build's 40-character commit in `--source-file`, for example
`{"commit":"YOUR_FULL_COMMIT"}`. Optional `dirty` and `assets` fields retain
additional build details. The runner records the commit and artifact source in
every case. It does not rebuild or deploy a site.

1. Call T3 `device_list`. Select iPhone 17e with UDID
   `C4D2FFD4-A0D2-4608-B180-35854521B830` on the Mac device host.
2. Use the maintained [visible iPhone wrapper and Mac FIFO](../goals-matrix.md#run-visible-iphone-safari-with-xctest-input)
   to serve the same prepared bytes on the Mac and forward its observer port.
   Set `--mac-thread` below to the FIFO holder's thread ID. Keep that wrapper and
   admission alive for the entire smoke. A 6,000-second workload hang cap covers
   all three cases and their cleanup. Queue wait time is separate.
3. Once the FIFO admits your wrapper and its server is ready, call `device_open`
   with that device's host ID and UDID. Keep its exact absolute bound
   `agent-device` command. The runner uses it for Safari, taps, and tab cleanup.

The runner verifies the same supervised FIFO ticket before each case. It does
not acquire another Mac ticket. The wrapper checks owner availability and refuses
an active SafariDriver. Do not run this check alongside a native Safari campaign.

## Run the smoke

Use a fresh output directory whose parent already exists. All value options use
`--name=value`. List the supported cases with `bun scripts/iphone-smoke.ts --list`.

```sh
source env.sh
bun /work/heavy-runner/current/run.js --host local --class browser iphone-smoke -- \
	bun scripts/iphone-smoke.ts \
	--root=/absolute/prepared-site \
	--output=/absolute/results/new-iphone-smoke \
	--source-file=/absolute/source.json \
	--iphone-control-url=http://127.0.0.1:FORWARDED_PORT/__goals_iphone/TOKEN \
	--iphone-agent-command=/exact/device_open/path/agent-device \
	--device-udid=C4D2FFD4-A0D2-4608-B180-35854521B830 \
	--mac-thread=FIFO_HOLDER_THREAD
```

`--asset-source` defaults to the prepared root path. Use it to label another build
source when the source file omits `assets`. The remaining options above are
required. Other devices, engines, and case selections are rejected.

Startup, dev, render, and click each have a five-minute hang cap. Install has a
ten-minute hang cap. The maintained cleanup phase has a twenty-second hang cap.
Every phase records its actual duration. A slow successful outcome passes.

## Check the deployed site

For a deploy check, run the same three cases against the public site instead of a
local build. Replace `--root` and `--source-file` with `--base-url`, the site root:

```sh
bun scripts/iphone-smoke.ts --base-url=https://bun.sprockt.dev/ \
	--output=/absolute/results/new-iphone-smoke \
	--iphone-control-url=http://127.0.0.1:FORWARDED_PORT/__goals_iphone/TOKEN \
	--iphone-agent-command=/exact/device_open/path/agent-device \
	--device-udid=C4D2FFD4-A0D2-4608-B180-35854521B830 \
	--mac-thread=FIFO_HOLDER_THREAD
```

No PC build and no staged site are needed. The runner reads the commit from the
site's `deployment.json` and records it, with the Waffle version, as the result's
source. It downloads the deployed playground's host page, manifest and selected
engine files and runs the same fingerprint preflight before the first case and after
the last. A deployment that changes during the run makes the result red.

The page still needs the observer script, which the deployed site cannot carry.
Start the same Mac wrapper with `LIVE_URL=https://bun.sprockt.dev/` in place of
`ROOT` and `PREVIEW_ORIGINS`, and stage only the two controller bundles. The
observer server then forwards every request to the live site with Safari's own
headers, including `Accept-Encoding`, and serves the response on Mac loopback.
Safari opens `/playground/` at that loopback origin. Forward its control port as
in local mode. FIFO admission, device binding, phases, hang caps, result file and
the ordinary-tab finish are unchanged. Live mode cannot serve root-preview
templates, so it refuses them.

Only two kinds of response differ from what the live site sends. For HTML
navigations and `sw.js`, the proxy asks the site for identity encoding, and the
observer adds its script and replaces their `cache-control` (with `no-store`),
`etag`, `last-modified` and `content-length`. Every other response reaches Safari
with its status, headers, content encoding and bytes unchanged. The observer never
adds isolation headers in live mode. Before any device work, the runner requires the
deployed playground page to send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). If either is
missing, the result is red at the `isolation` step.

After the cases, the runner checks the edge. The proxy records each whole,
unconditional request it made and what came back. The PC repeats each request
against `https://bun.sprockt.dev/` with the same headers. It compares status,
`Content-Type`, `Content-Encoding`, COOP, COEP, CORP, `Cache-Control`,
`Service-Worker-Allowed` and the decoded bytes. Any difference makes the result
red at the `live-origin` step, and `liveOrigin` in the result lists them. The PC
and the Mac may reach different Cloudflare locations; the commit check before and
after the run catches a deployment that changes partway through.

This mode can't prove:

- Safari's own connection to the Cloudflare edge: TLS, HTTP/2 or HTTP/3, and edge
  caching keyed on Safari's request. Bun's fetch on the Mac makes those requests.
- Behavior tied to the real origin `https://bun.sprockt.dev`: per-origin storage
  and service-worker state, and absolute URLs to that host. Under the proxy, those
  URLs become cross-origin loads.
- The deployed caching of the injected HTML and `sw.js`, including how the service
  worker updates. Both are served with `no-store`.

Follow-up: load the real origin in Safari without injection for one case, with a
success signal that doesn't need the observer.

## Read the result and finish cleanup

Read `<output>/result.json`. `status` is `green` only when all three cases pass,
their cleanup succeeds, and the host and guest fingerprints still match. `failedPhase`
names the first failure. Each case retains its phases, actual durations, failures,
source identity, browser identity, and cleanup evidence. Logs and native command
evidence are under `<output>/logs`. The command exits nonzero for any failure,
blocked case, or interruption. It never writes a canonical matrix table.

An ordinary framework failure skips its later phases and attempts the remaining
cases. A failed device command, failed cleanup, changed FIFO ticket, or
interruption blocks further native input. Prerequisite failures produce a red
result before any device command. The runner atomically saves the result after
each case and at completion.

The resolved profile is reused for asset preflight, execution and the playground
URL. Startup must report that same running profile, and final verification checks
the same selected assets after cleanup. Profile policy stays in the shared
frontend helper; the smoke command has no separate template/profile map.

The runner selects the ordinary numbered group before counting tabs. It closes
only the unique recorded task title through that card's own Close child. If the
owned card is in Private, cleanup proves its removal and preserves the other
visible private cards without treating the ordinary number as a Private count.
It also proves the ordinary count and contents unchanged. Cleanup finishes by
selecting ordinary tabs, pressing Done with settling, and proving overview exit.
Missing ownership or failed proof remains red.

Install the PC controller's finalizer before opening Safari. On success, failure
or cancellation, while the same device binding and FIFO admission are still
owned, finish owned-tab cleanup and ordinary restoration before `device_close`,
stopping the wrapper or releasing FIFO. Use the same bounded cleanup helpers as
the runner. A manual deploy check must follow this finish procedure too. Never
close unrelated private tabs. After a failed native command, expired deadline or
lost ownership, issue no further UI input and record that restoration is unproved.
Preserve the original failure. The Mac server wrapper has no PC device binding
and must not drive Safari through SSH or simctl.

After the PC finalizer exits, stop the wrapper and owned forward, collect the wrapper's cleanup receipt, verify
that its server and listeners stopped, and check that its FIFO ticket is gone.
Remove task staging only after its consumers stop. Close your T3 device session
without shutting down the retained simulator. Keep the results. Remove disposable
builds after use. The smoke's green result covers case cleanup. The deployment
operator also owns wrapper, forward, session, and staging cleanup.
