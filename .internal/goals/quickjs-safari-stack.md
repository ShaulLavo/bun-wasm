# QuickJS Safari stack

Status: Implemented. Framework replay remains coordinator-owned.

QuickJS now dispatches native callable classes before allocating its bytecode
interpreter activation. This removes 288 unused shadow bytes per native hop in
the produced WASI build. The 32 KiB Safari budget and every existing guard stay.

The focused native-call fixture fails before the engine change and passes after
it on the same production core. It passes on QuickJS, JSC and the browser engine.
Native Safari 26.4 passes all 25 original cold recursion paths, both overflow
fixtures and the focused native-call control at both 32 and 40 KiB. The original
fixture outputs match exactly. No host trap occurred.

Shared CommonJS loader work belongs to PR 570. JSC work is excluded. No result
here establishes acceptance of the nine framework cells. The parent owns their
original-deadline replay, independent review and merge.
