(function () {
  type SocketOptions = { onread?: unknown; signal?: unknown; [key: string]: unknown };
  return function socketState(options: SocketOptions | null | undefined) {
    const { onread, signal, ...streamOptions } = options || {};
    for (const name of ["objectMode", "readableObjectMode", "writableObjectMode"]) {
      const mode = Object.hasOwn(streamOptions, name) ? streamOptions[name] : options?.[name];
      if (!mode) continue;
      throw Object.assign(new TypeError(`The argument 'options.${name}' is not supported`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    return { onread, signal, streamOptions };
  };
})
