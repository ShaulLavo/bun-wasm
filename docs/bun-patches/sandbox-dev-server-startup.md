# Sandbox dev server startup errors

Class **Host feature**, original sandbox adapter. No upstream implementation is copied.

`sandbox/src/sandbox.ts` observes listener notifications for each command. When the
requested dev server exits before opening a listener, the sandbox marks startup as
failed and directs the user to the terminal and Restart. A successful exit with no
runtime error gets one terminal diagnostic instead of the ordinary dim exit line.
Existing command errors and nonzero exits retain their terminal diagnostics.

Successful installation does not require a listener. A dev server that opened a
listener and then closed keeps the ordinary stopped state. Listener history belongs
to that command and does not carry into Restart.

`scripts/sandbox-dev-server.test.ts` exercises the real sandbox class and rendered
status through the existing UI harness. Its listening controls use Waffle's unchanged
network helper and namespace at the dependency revision pinned by the lockfiles.
The Web gate owns the test through `checks/web-sandbox-dev-server.json`.
