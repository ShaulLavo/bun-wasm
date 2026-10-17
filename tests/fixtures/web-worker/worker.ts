const handler = function(event) {
  postMessage({ byte: event.data.data[0], main: Bun.isMainThread, arg: process.argv[2], env: process.env.WORKER_ONLY,
    same: onmessage === handler });
};
onmessage = handler;
