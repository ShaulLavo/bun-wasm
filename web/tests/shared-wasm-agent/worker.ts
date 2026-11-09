// The production worker, plus one Web Lock held for the agent's whole life. The browser releases it
// when this agent's context is destroyed, which a page can see and a terminate() return cannot prove.
// It is named worker.ts so the test site's worker.js has the production path.
import "../../src/worker";

if (self.name) void navigator.locks.request(self.name, () => new Promise<void>(() => {}));
