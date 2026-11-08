# Native goals Safari startup

Classification: original local adapter. No upstream source is copied or patched.

`scripts/goals-matrix/native.ts` and `native-safari.ts` adapt the installed macOS
`launchctl`, `open`, `ps`, and SafariDriver commands for the goals campaign. The
existing Mac lock, owner availability check, and unlocked-console check run first.
Desktop Safari starts with `launchctl asuser <uid> open -a Safari --env BUN_WASM_GOALS_SAFARI_OWNER=<unique marker>`, followed by a
finite five-second GUI startup allowance and a live process check before the
driver starts. SafariDriver still launches through the GUI session. Its readiness
bound and all product phase deadlines are unchanged. Simulator-only runs do not
launch desktop Safari.

The application lifetime records a pending launch before `open`. A process is
owned only after its environment contains that launch's unique marker. A process
birth time alone never proves ownership, including an owner launch racing `open`.
Cleanup settles a pending launch within a finite bound. If ownership remains
unproved, it preserves the application and lock rather than claiming success.
Before each signal, cleanup checks the marker, PID and start time. The application
stops only after driver exit is proved; a failed driver shutdown preserves both
its dependent application and lock. Already-running Safari is not relaunched or owned. No preferences, automation settings, login state, or
credentials change.

The November 8, 2026 setup control reproduced a 30-second session failure without
prelaunch. A separate managing control succeeded with Safari 26.4 after ordinary
prelaunch and about five seconds of startup time. Source and lifetime regressions
are registered under `checks/quality-goals-matrix-native.json`; native campaign
acceptance remains a separate real-Mac run after review and merge.
