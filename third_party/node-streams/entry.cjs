module.exports = {
  Stream: require('readable-stream/lib/stream'),
  errors: require('readable-stream/lib/ours/errors'),
  validators: require('readable-stream/lib/internal/validators'),
  utils: require('readable-stream/lib/internal/streams/utils'),
  eos: require('readable-stream/lib/internal/streams/end-of-stream'),
  primordials: require('readable-stream/lib/ours/primordials'),
  util: require('readable-stream/lib/ours/util'),
  state: require('readable-stream/lib/internal/streams/state'),
};
