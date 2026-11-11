// Deprecation helpers capture without a constructor to skip, drop their own frame and read
// a location from each remaining CallSite.
exports.callerLocations = function callerLocations() {
  const previous = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (error, sites) => sites;
    const target = {};
    Error.captureStackTrace(target);
    return target.stack.slice(1).map(site => ({
      name: site.getFunctionName(),
      file: site.getFileName(),
      line: site.getLineNumber(),
      column: site.getColumnNumber(),
    }));
  } finally {
    Error.prepareStackTrace = previous;
  }
};

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
