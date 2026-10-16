exports.capture = function capture() {
  const previous = Error.prepareStackTrace;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 20;
    Error.prepareStackTrace = (error, sites) => sites;
    const target = {};
    Error.captureStackTrace(target, capture);
    return target.stack;
  } finally {
    Error.prepareStackTrace = previous;
    Error.stackTraceLimit = previousLimit;
  }
};
