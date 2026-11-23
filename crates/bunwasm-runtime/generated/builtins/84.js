// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/fast-utf8-stream.ts.
(function (intrinsics) {
"use strict";
var $, { validateBoolean, validateFunction, validateObject, validateOneOf, validateString, validateUint32 } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 122) || intrinsics.createInternalModuleById(122), EventEmitter = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 153) || intrinsics.createInternalModuleById(153), path = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 164) || intrinsics.createInternalModuleById(164), _fs;
function lazyFs() {
    return _fs ??= intrinsics.getInternalField(intrinsics.internalModuleRegistry, 155) || intrinsics.createInternalModuleById(155);
}
var BUSY_WRITE_TIMEOUT = 100, kEmptyBuffer = intrinsics.Buffer.allocUnsafe(0), kMaxWrite = 16384, kContentModeBuffer = "buffer", kContentModeUtf8 = "utf8", kNullPrototype = { __proto__: null };
function sleep(ms) {
    Bun.sleepSync(ms);
}
class Utf8Stream extends EventEmitter {
    #len = 0;
    #fd = -1;
    #bufs = [];
    #lens = [];
    #writing = !1;
    #ending = !1;
    #reopening = !1;
    #asyncDrainScheduled = !1;
    #flushPending = !1;
    #hwm = 16387;
    #file = null;
    #destroyed = !1;
    #minLength = 0;
    #maxLength = 0;
    #maxWrite = kMaxWrite;
    #opening = !1;
    #periodicFlush = 0;
    #periodicFlushTimer = intrinsics.undefined;
    #sync = !1;
    #fsync = !1;
    #append = !0;
    #mode;
    #retryEAGAIN = () => !0;
    #mkdir = !1;
    #writingBuf = "";
    #write;
    #flush;
    #flushSync;
    #actualWrite;
    #fsWriteSync;
    #fsWrite;
    #fs;
    constructor(options = kNullPrototype) {
        validateObject(options, "options");
        let { fd } = options, { dest, minLength, maxLength, maxWrite, periodicFlush, sync, append = !0, mkdir, retryEAGAIN, fsync, contentMode = kContentModeUtf8, mode, fs: overrideFs = {} } = options;
        super();
        fd ??= dest, validateObject(overrideFs, "options.fs"), this.#fs = { ...lazyFs(), ...overrideFs }, validateFunction(this.#fs.write, "options.fs.write"), validateFunction(this.#fs.writeSync, "options.fs.writeSync"), validateFunction(this.#fs.fsync, "options.fs.fsync"), validateFunction(this.#fs.fsyncSync, "options.fs.fsyncSync"), validateFunction(this.#fs.close, "options.fs.close"), validateFunction(this.#fs.open, "options.fs.open"), validateFunction(this.#fs.mkdir, "options.fs.mkdir"), validateFunction(this.#fs.mkdirSync, "options.fs.mkdirSync"), this.#hwm = Math.max(minLength || 0, this.#hwm), this.#minLength = minLength || 0, this.#maxLength = maxLength || 0, this.#maxWrite = maxWrite || kMaxWrite, this.#periodicFlush = periodicFlush || 0, this.#sync = sync || !1, this.#fsync = fsync || !1, this.#append = append || !1, this.#mode = mode, this.#retryEAGAIN = retryEAGAIN || (() => !0), this.#mkdir = mkdir || !1, validateUint32(this.#hwm, "options.hwm"), validateUint32(this.#minLength, "options.minLength"), validateUint32(this.#maxLength, "options.maxLength"), validateUint32(this.#maxWrite, "options.maxWrite"), validateUint32(this.#periodicFlush, "options.periodicFlush"), validateBoolean(this.#sync, "options.sync"), validateBoolean(this.#fsync, "options.fsync"), validateBoolean(this.#append, "options.append"), validateBoolean(this.#mkdir, "options.mkdir"), validateFunction(this.#retryEAGAIN, "options.retryEAGAIN"), validateOneOf(contentMode, "options.contentMode", [kContentModeBuffer, kContentModeUtf8]);
        let boundRelease = this.#release.bind(this);
        if (contentMode === kContentModeBuffer)
            this.#writingBuf = kEmptyBuffer, this.#write = this.#writeBuffer.bind(this), this.#flush = this.#flushBuffer.bind(this), this.#flushSync = this.#flushBufferSync.bind(this), this.#actualWrite = this.#actualWriteBuffer.bind(this), this.#fsWriteSync = function fsWriteSyncBuffer() {
                return this.#fs.writeSync(this.#fd, this.#writingBuf);
            }.bind(this), this.#fsWrite = function fsWriteBuffer() {
                return this.#fs.write(this.#fd, this.#writingBuf, boundRelease);
            }.bind(this);
        else
            this.#writingBuf = "", this.#write = this.#writeUtf8.bind(this), this.#flush = this.#flushUtf8.bind(this), this.#flushSync = this.#flushSyncUtf8.bind(this), this.#actualWrite = this.#actualWriteUtf8.bind(this), this.#fsWriteSync = function fsWriteSyncUtf8() {
                return this.#fs.writeSync(this.#fd, this.#writingBuf, "utf8");
            }.bind(this), this.#fsWrite = function fsWriteUtf8() {
                return this.#fs.write(this.#fd, this.#writingBuf, "utf8", boundRelease);
            }.bind(this);
        if (typeof fd === "number")
            this.#fd = fd, process.nextTick(() => this.emit("ready"));
        else if (typeof fd === "string")
            this.#openFile(fd);
        else
            throw intrinsics.makeErrorWithCode(112, "fd", ["number", "string"], fd);
        if (this.#minLength >= this.#maxWrite)
            throw intrinsics.makeErrorWithCode(114, "minLength", this.#minLength, `should be smaller than maxWrite (${this.#maxWrite})`);
        if (this.on("newListener", (name) => {
            if (name === "drain")
                this.#asyncDrainScheduled = !1;
        }), this.#periodicFlush !== 0)
            this.#periodicFlushTimer = setInterval(() => this.flush(null), this.#periodicFlush), this.#periodicFlushTimer.unref();
    }
    write(data) {
        return this.#write(data);
    }
    flush(cb = function (_err) { }) {
        this.#flush(cb);
    }
    flushSync() {
        return this.#flushSync();
    }
    reopen(file) {
        if (this.#destroyed)
            throw intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
        if (this.#opening) {
            this.once("ready", () => this.reopen(file));
            return;
        }
        if (this.#ending)
            return;
        if (!this.#file)
            throw intrinsics.makeErrorWithCode(148, "Unable to reopen a file descriptor, you must pass a file to SonicBoom");
        if (file)
            this.#file = file;
        if (this.#reopening = !0, this.#writing)
            return;
        let fd = this.#fd;
        this.once("ready", () => {
            if (fd !== this.#fd)
                this.#fs.close(fd, (err) => {
                    if (err)
                        return this.emit("error", err);
                });
        }), this.#openFile(this.#file);
    }
    end() {
        if (this.#destroyed)
            throw intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
        if (this.#opening) {
            this.once("ready", () => {
                this.end();
            });
            return;
        }
        if (this.#ending)
            return;
        if (this.#ending = !0, this.#writing)
            return;
        if (this.#len > 0 && this.#fd >= 0)
            this.#actualWrite();
        else
            this.#actualClose();
    }
    destroy() {
        if (this.#destroyed)
            return;
        this.#actualClose();
    }
    get mode() {
        return this.#mode;
    }
    get file() {
        return this.#file;
    }
    get fd() {
        return this.#fd;
    }
    get minLength() {
        return this.#minLength;
    }
    get maxLength() {
        return this.#maxLength;
    }
    get writing() {
        return this.#writing;
    }
    get sync() {
        return this.#sync;
    }
    get fsync() {
        return this.#fsync;
    }
    get append() {
        return this.#append;
    }
    get periodicFlush() {
        return this.#periodicFlush;
    }
    get contentMode() {
        return this.#writingBuf instanceof intrinsics.Buffer ? kContentModeBuffer : kContentModeUtf8;
    }
    get mkdir() {
        return this.#mkdir;
    }
    [Symbol.dispose]() {
        this.destroy();
    }
    #release(err, n) {
        if (err) {
            if ((err.code === "EAGAIN" || err.code === "EBUSY") && this.#retryEAGAIN(err, this.#writingBuf.length, this.#len - this.#writingBuf.length))
                if (this.#sync)
                    try {
                        sleep(BUSY_WRITE_TIMEOUT), this.#release(intrinsics.undefined, 0);
                    }
                    catch (err) {
                        this.#release(err);
                    }
                else
                    setTimeout(() => this.#fsWrite(), BUSY_WRITE_TIMEOUT);
            else
                this.#writing = !1, this.emit("error", err);
            return;
        }
        this.emit("write", n);
        let releasedBufObj = releaseWritingBuf(this.#writingBuf, this.#len, n);
        if (this.#len = releasedBufObj.len, this.#writingBuf = releasedBufObj.writingBuf, this.#writingBuf.length) {
            if (!this.#sync) {
                this.#fsWrite();
                return;
            }
            try {
                do {
                    let n = this.#fsWriteSync(), releasedBufObj = releaseWritingBuf(this.#writingBuf, this.#len, n);
                    this.#len = releasedBufObj.len, this.#writingBuf = releasedBufObj.writingBuf;
                } while (this.#writingBuf.length);
            }
            catch (err) {
                this.#release(err);
                return;
            }
        }
        if (this.#fsync)
            this.#fs.fsyncSync(this.#fd);
        let len = this.#len;
        if (this.#reopening)
            this.#writing = !1, this.#reopening = !1, this.reopen();
        else if (len > this.#minLength)
            this.#actualWrite();
        else if (this.#ending)
            if (len > 0)
                this.#actualWrite();
            else
                this.#writing = !1, this.#actualClose();
        else if (this.#writing = !1, this.#sync) {
            if (!this.#asyncDrainScheduled)
                this.#asyncDrainScheduled = !0, process.nextTick(() => this.#emitDrain());
        }
        else
            this.emit("drain");
    }
    #openFile(file) {
        this.#opening = !0, this.#writing = !0, this.#asyncDrainScheduled = !1;
        let fileOpened = (err, fd) => {
            if (err) {
                if (this.#reopening = !1, this.#writing = !1, this.#opening = !1, this.#sync)
                    process.nextTick(() => {
                        if (this.listenerCount("error") > 0)
                            this.emit("error", err);
                    });
                else
                    this.emit("error", err);
                return;
            }
            let reopening = this.#reopening;
            if (this.#fd = fd, this.#file = file, this.#reopening = !1, this.#opening = !1, this.#writing = !1, this.#sync)
                process.nextTick(() => this.emit("ready"));
            else
                this.emit("ready");
            if (this.#destroyed)
                return;
            if (!this.#writing && this.#len > this.#minLength || this.#flushPending)
                this.#actualWrite();
            else if (reopening)
                process.nextTick(() => {
                    if (!this.#writing)
                        this.emit("drain");
                });
        }, flags = this.#append ? "a" : "w", mode = this.#mode;
        if (this.#sync)
            try {
                if (this.#mkdir)
                    this.#fs.mkdirSync(path.dirname(file), { recursive: !0 });
                let fd = this.#fs.openSync(file, flags, mode);
                fileOpened(null, fd);
            }
            catch (err) {
                throw fileOpened(err), err;
            }
        else if (this.#mkdir)
            this.#fs.mkdir(path.dirname(file), { recursive: !0 }, (err) => {
                if (err)
                    return fileOpened(err);
                this.#fs.open(file, flags, mode, fileOpened);
            });
        else
            this.#fs.open(file, flags, mode, fileOpened);
    }
    #emitDrain() {
        if (!(this.listenerCount("drain") > 0))
            return;
        this.#asyncDrainScheduled = !1, this.emit("drain");
    }
    #actualClose() {
        if (this.#fd === -1) {
            this.once("ready", () => this.#actualClose());
            return;
        }
        if (this.#periodicFlushTimer !== intrinsics.undefined)
            clearInterval(this.#periodicFlushTimer);
        this.#destroyed = !0, this.#bufs = [], this.#lens = [];
        let done = (err) => {
            if (err) {
                this.emit("error", err);
                return;
            }
            if (this.#ending && !this.#writing)
                this.emit("finish");
            this.emit("close");
        }, closeWrapped = () => {
            if (this.#fd !== 1 && this.#fd !== 2)
                this.#fs.close(this.#fd, done);
            else
                done(null);
        };
        try {
            this.#fs.fsync(this.#fd, closeWrapped);
        }
        catch { }
    }
    #actualWriteBuffer() {
        if (this.#writing = !0, this.#writingBuf = this.#writingBuf.length ? this.#writingBuf : mergeBuf(this.#bufs.shift(), this.#lens.shift()), this.#sync)
            try {
                let written = this.#fs.writeSync(this.#fd, this.#writingBuf);
                this.#release(null, written);
            }
            catch (err) {
                this.#release(err);
            }
        else
            this.#writingBuf = intrinsics.Buffer.from(this.#writingBuf), this.#fsWrite();
    }
    #actualWriteUtf8() {
        if (this.#writing = !0, this.#writingBuf ||= this.#bufs.shift() || "", this.#sync)
            try {
                let written = this.#fs.writeSync(this.#fd, this.#writingBuf, "utf8");
                this.#release(null, written);
            }
            catch (err) {
                this.#release(err);
            }
        else
            this.#fsWrite();
    }
    #flushBufferSync() {
        if (this.#destroyed)
            throw intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
        if (this.#fd < 0)
            throw intrinsics.makeErrorWithCode(129, "Invalid file descriptor");
        if (!this.#writing && this.#writingBuf.length > 0)
            this.#bufs.unshift([this.#writingBuf]), this.#writingBuf = kEmptyBuffer;
        let buf = kEmptyBuffer;
        while (this.#bufs.length || buf.length) {
            if (buf.length <= 0)
                buf = mergeBuf(this.#bufs[0], this.#lens[0]);
            try {
                let n = this.#fs.writeSync(this.#fd, buf);
                if (buf = buf.subarray(n), this.#len = Math.max(this.#len - n, 0), buf.length <= 0)
                    this.#bufs.shift(), this.#lens.shift();
            }
            catch (err) {
                if ((err.code === "EAGAIN" || err.code === "EBUSY") && !this.#retryEAGAIN(err, buf.length, this.#len - buf.length))
                    throw err;
                sleep(BUSY_WRITE_TIMEOUT);
            }
        }
    }
    #flushSyncUtf8() {
        if (this.#destroyed)
            throw intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
        if (this.#fd < 0)
            throw intrinsics.makeErrorWithCode(129, "Invalid file descriptor");
        if (!this.#writing && this.#writingBuf.length > 0)
            this.#bufs.unshift(this.#writingBuf), this.#writingBuf = "";
        let buf = "";
        while (this.#bufs.length || buf) {
            if (buf.length <= 0)
                buf = this.#bufs[0];
            try {
                let n = this.#fs.writeSync(this.#fd, buf, "utf8"), releasedBufObj = releaseWritingBuf(buf, this.#len, n);
                if (buf = releasedBufObj.writingBuf, this.#len = releasedBufObj.len, buf.length <= 0)
                    this.#bufs.shift();
            }
            catch (err) {
                if ((err.code === "EAGAIN" || err.code === "EBUSY") && !this.#retryEAGAIN(err, buf.length, this.#len - buf.length))
                    throw err;
                sleep(BUSY_WRITE_TIMEOUT);
            }
        }
        try {
            this.#fs.fsyncSync(this.#fd);
        }
        catch { }
    }
    #callFlushCallbackOnDrain(cb) {
        this.#flushPending = !0;
        let onDrain = () => {
            if (!this.#fsync && !this.#destroyed)
                try {
                    this.#fs.fsync(this.#fd, (err) => {
                        if (this.#flushPending = !1, err?.code === "EBADF") {
                            cb();
                            return;
                        }
                        cb(err);
                    });
                }
                catch (err) {
                    this.#flushPending = !1, cb(err);
                }
            else
                this.#flushPending = !1, cb();
            this.off("error", onError);
        }, onError = (err) => {
            this.#flushPending = !1, cb(err), this.off("drain", onDrain);
        };
        this.once("drain", onDrain), this.once("error", onError);
    }
    #flushBuffer(cb) {
        if (validateFunction(cb, "cb"), this.#destroyed) {
            let error = intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
            if (cb) {
                cb(error);
                return;
            }
            throw error;
        }
        if (this.#minLength <= 0) {
            cb?.();
            return;
        }
        if (cb)
            this.#callFlushCallbackOnDrain(cb);
        if (this.#writing)
            return;
        if (this.#bufs.length === 0)
            this.#bufs.push([]), this.#lens.push(0);
        this.#actualWrite();
    }
    #flushUtf8(cb) {
        if (validateFunction(cb, "cb"), this.#destroyed) {
            let error = intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
            if (cb) {
                cb(error);
                return;
            }
            throw error;
        }
        if (this.#minLength <= 0) {
            cb?.();
            return;
        }
        if (cb)
            this.#callFlushCallbackOnDrain(cb);
        if (this.#writing)
            return;
        if (this.#bufs.length === 0)
            this.#bufs.push("");
        this.#actualWrite();
    }
    #writeBuffer(data) {
        if (this.#destroyed)
            throw intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
        if (!intrinsics.Buffer.isBuffer(data))
            throw intrinsics.makeErrorWithCode(112, "data", "Buffer", data);
        let dataLength = data.length, len = this.#len + dataLength, bufs = this.#bufs, lens = this.#lens;
        if (this.#maxLength && len > this.#maxLength)
            return this.emit("drop", data), this.#len < this.#hwm;
        if (bufs.length === 0 || lens[lens.length - 1] + dataLength > this.#maxWrite)
            bufs.push([]), lens.push(dataLength);
        else
            bufs[bufs.length - 1].push(data), lens[lens.length - 1] += dataLength;
        if (this.#len = len, !this.#writing && this.#len >= this.#minLength)
            this.#actualWrite();
        return this.#len < this.#hwm;
    }
    #writeUtf8(data) {
        if (this.#destroyed)
            throw intrinsics.makeErrorWithCode(129, "Utf8Stream is destroyed");
        validateString(data, "data");
        let dataLength = data.length, len = this.#len + dataLength, bufs = this.#bufs;
        if (this.#maxLength && len > this.#maxLength)
            return this.emit("drop", data), this.#len < this.#hwm;
        if (bufs.length === 0 || bufs[bufs.length - 1].length + dataLength > this.#maxWrite)
            bufs.push("" + data);
        else
            bufs[bufs.length - 1] += data;
        if (this.#len = len, !this.#writing && this.#len >= this.#minLength)
            this.#actualWrite();
        return this.#len < this.#hwm;
    }
}
function releaseWritingBuf(writingBuf, len, n) {
    if (typeof writingBuf === "string") {
        if (intrinsics.Buffer.byteLength(writingBuf) !== n) {
            let buf = intrinsics.Buffer.from(writingBuf);
            while (n > 0 && (buf[n] & 192) === 128)
                n--;
            n = buf.subarray(0, n).toString().length;
        }
    }
    return len = Math.max(len - n, 0), writingBuf = writingBuf.slice(n), { writingBuf, len };
}
function mergeBuf(bufs, len) {
    if (bufs.length === 0)
        return kEmptyBuffer;
    if (bufs.length === 1)
        return bufs[0];
    return intrinsics.Buffer.concat(bufs, len);
}
$ = Utf8Stream;
return $;
})
