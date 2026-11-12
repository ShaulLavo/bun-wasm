// Requested before the production worker evaluates, so the guest cannot start first. The browser
// grants it whether or not this thread later blocks. A refused request simply never arms the page.
if (self.name && navigator.locks) void navigator.locks.request(self.name, () => new Promise<void>(() => {})).catch(() => {});
