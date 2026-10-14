let loads = (globalThis.__loads = (globalThis.__loads || 0) + 1);
exports.greet = (name) => `hello ${name} (loads=${loads})`;
exports.version = 2;
