(function (internal: BunWasm.Internal) {
  type Callback = (error?: unknown) => void;
  type Response = {
    destroyed: boolean;
    closed: boolean;
    finished: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    _completed: boolean;
    _destroyError?: unknown;
    socket?: { destroy(error?: unknown): unknown; removeListener(event: string, listener: () => void): unknown };
    _socketClosed: () => void;
    _conn: { destroy(error?: unknown): void };
    _done(keepAlive: boolean): void;
    _emitClose(): void;
    emit(event: string): unknown;
  };

  function destroy(this: Response, error?: unknown): Response {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._completed = true;
    this._destroyError = error || Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
    if (this.socket) this.socket.destroy(error);
    else {
      this._conn.destroy(this._destroyError);
      internal.nextTick(() => this._emitClose());
    }
    return this;
  }

  function emitClose(this: Response): void {
    if (this.closed) return;
    this.closed = true;
    this.destroyed = true;
    if (!this.writableFinished) {
      this._completed = true;
      this._done(false);
    }
    this.emit("close");
  }

  function endDestroyed(this: Response): Response {
    this.writableEnded = this.finished = true;
    return this;
  }

  function completeEnd(this: Response, callback?: Callback, error?: unknown): void {
    if (this.destroyed) {
      if (typeof callback === "function") callback(error || this._destroyError);
      return;
    }
    if (this.socket) this.socket.removeListener("close", this._socketClosed);
    if (error) {
      if (typeof callback === "function") callback(error);
      this._emitClose();
      return;
    }
    this.writableFinished = true;
    if (typeof callback === "function") callback();
    this.emit("finish");
    this._emitClose();
  }

  function writeDestroyed(callback?: Callback): false {
    const error = Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
    if (typeof callback === "function") internal.nextTick(() => callback(error));
    return false;
  }

  return { destroy, _emitClose: emitClose, _endDestroyed: endDestroyed, _completeEnd: completeEnd, _writeDestroyed: writeDestroyed };
})
