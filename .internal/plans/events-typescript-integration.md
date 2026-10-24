# Events TypeScript integration

Status: Approved. Source corrections integrated; parent owns independent integration review, required CI and guarded merge of PR146.

The owned feature range starts at `ac43127c85addabed7e0c2a4883247ae074e858c`, excluding squash-landed PR140. Production events source remains byte-identical to accepted `4acbe9273042846a99ba0fd3f234536e8e0874b5`. B2 test-only correction is `16e4b72d9f19a95a6953c46692e98414a10bfdee`. B1 shared inspector/probe correction is the source-only R5-approved report-local candidate.

Foundation base is `356e4fd7a7dd167da27fdc1a994c48bc2488919b`. Preserve its versions, Waffle pin, existing manifests, workflow, caches, producers and split documentation. New runtime probe and six event fixtures have one blocking owner each under `checks/`. Web retains the existing declaration probe and signal test owners. The CI command assertion follows current manifest discovery, not the immutable migration baseline. The discovery test compares all original local-runtime members while allowing new feature-owned probes, matching the migration proof.

Review only the genuinely new integration delta: the discovery manifests, split provenance record, CI discovery assertion and their wiring to the unchanged accepted feature. The B1/probe correction and both B2 assertion/depth contracts are preserved. Newer main format-limit/Blob declarations and their compile cases remain unchanged. No new runtime, guest, native, browser, network or real-callback validation is claimed. Historical R4 evidence and failures keep their original attribution.

The rerunnable before/main/final source proof, check logs and cleanup ownership are retained in `/work/reports/bun-wasm/post-foundation/pr-146/`. Parent owns their removal after landing verification. No exhaustive parity or final-size campaign is required here.
