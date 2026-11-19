// Without a callable process._fatalException an uncaught throw exits 6, as in Node.
process.on("exit", code => console.log("exit", code, process.exitCode));
delete (process as { _fatalException?: unknown })._fatalException;
throw new Error("ok");
