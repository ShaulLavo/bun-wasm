process.send!({
  execArgv: process.execArgv,
  argv: process.argv.slice(2),
  bunOptions: process.env.BUN_OPTIONS ?? null,
});
