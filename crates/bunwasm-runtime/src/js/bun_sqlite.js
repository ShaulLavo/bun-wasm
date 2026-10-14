// bun:sqlite. A port of Bun's src/js/bun/sqlite.ts onto `native.sqlite`
// (src/sqlite.rs), which wraps a real SQLite compiled for WASI. Bun's C++
// statement class (JSSQLStatement.cpp) is split here: this file decides what
// to bind (named parameters, strict mode, BigInt ranges) and shapes results;
// the native side binds positional values, steps and builds rows.
(function (internal) {
  "use strict";

  const sql = internal.native.sqlite;

  const kSafeIntegersFlag = 1 << 1;
  const kStrictFlag = 1 << 2;
  const kPrepareOwned = Symbol("prepareOwned");

  const defineProperties = Object.defineProperties;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const isArray = Array.isArray;
  const isTypedArray = ArrayBuffer.isView;

  const constants = {
    SQLITE_OPEN_READONLY: 0x00000001,
    SQLITE_OPEN_READWRITE: 0x00000002,
    SQLITE_OPEN_CREATE: 0x00000004,
    SQLITE_OPEN_DELETEONCLOSE: 0x00000008,
    SQLITE_OPEN_EXCLUSIVE: 0x00000010,
    SQLITE_OPEN_AUTOPROXY: 0x00000020,
    SQLITE_OPEN_URI: 0x00000040,
    SQLITE_OPEN_MEMORY: 0x00000080,
    SQLITE_OPEN_MAIN_DB: 0x00000100,
    SQLITE_OPEN_TEMP_DB: 0x00000200,
    SQLITE_OPEN_TRANSIENT_DB: 0x00000400,
    SQLITE_OPEN_MAIN_JOURNAL: 0x00000800,
    SQLITE_OPEN_TEMP_JOURNAL: 0x00001000,
    SQLITE_OPEN_SUBJOURNAL: 0x00002000,
    SQLITE_OPEN_SUPER_JOURNAL: 0x00004000,
    SQLITE_OPEN_NOMUTEX: 0x00008000,
    SQLITE_OPEN_FULLMUTEX: 0x00010000,
    SQLITE_OPEN_SHAREDCACHE: 0x00020000,
    SQLITE_OPEN_PRIVATECACHE: 0x00040000,
    SQLITE_OPEN_WAL: 0x00080000,
    SQLITE_OPEN_NOFOLLOW: 0x01000000,
    SQLITE_OPEN_EXRESCODE: 0x02000000,
    SQLITE_PREPARE_PERSISTENT: 0x01,
    SQLITE_PREPARE_NORMALIZE: 0x02,
    SQLITE_PREPARE_NO_VTAB: 0x04,

    SQLITE_DESERIALIZE_READONLY: 0x00000004,

    SQLITE_FCNTL_LOCKSTATE: 1,
    SQLITE_FCNTL_GET_LOCKPROXYFILE: 2,
    SQLITE_FCNTL_SET_LOCKPROXYFILE: 3,
    SQLITE_FCNTL_LAST_ERRNO: 4,
    SQLITE_FCNTL_SIZE_HINT: 5,
    SQLITE_FCNTL_CHUNK_SIZE: 6,
    SQLITE_FCNTL_FILE_POINTER: 7,
    SQLITE_FCNTL_SYNC_OMITTED: 8,
    SQLITE_FCNTL_WIN32_AV_RETRY: 9,
    SQLITE_FCNTL_PERSIST_WAL: 10,
    SQLITE_FCNTL_OVERWRITE: 11,
    SQLITE_FCNTL_VFSNAME: 12,
    SQLITE_FCNTL_POWERSAFE_OVERWRITE: 13,
    SQLITE_FCNTL_PRAGMA: 14,
    SQLITE_FCNTL_BUSYHANDLER: 15,
    SQLITE_FCNTL_TEMPFILENAME: 16,
    SQLITE_FCNTL_MMAP_SIZE: 18,
    SQLITE_FCNTL_TRACE: 19,
    SQLITE_FCNTL_HAS_MOVED: 20,
    SQLITE_FCNTL_SYNC: 21,
    SQLITE_FCNTL_COMMIT_PHASETWO: 22,
    SQLITE_FCNTL_WIN32_SET_HANDLE: 23,
    SQLITE_FCNTL_WAL_BLOCK: 24,
    SQLITE_FCNTL_ZIPVFS: 25,
    SQLITE_FCNTL_RBU: 26,
    SQLITE_FCNTL_VFS_POINTER: 27,
    SQLITE_FCNTL_JOURNAL_POINTER: 28,
    SQLITE_FCNTL_WIN32_GET_HANDLE: 29,
    SQLITE_FCNTL_PDB: 30,
    SQLITE_FCNTL_BEGIN_ATOMIC_WRITE: 31,
    SQLITE_FCNTL_COMMIT_ATOMIC_WRITE: 32,
    SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE: 33,
    SQLITE_FCNTL_LOCK_TIMEOUT: 34,
    SQLITE_FCNTL_DATA_VERSION: 35,
    SQLITE_FCNTL_SIZE_LIMIT: 36,
    SQLITE_FCNTL_CKPT_DONE: 37,
    SQLITE_FCNTL_RESERVE_BYTES: 38,
    SQLITE_FCNTL_CKPT_START: 39,
    SQLITE_FCNTL_EXTERNAL_READER: 40,
    SQLITE_FCNTL_CKSM_FILE: 41,
    SQLITE_FCNTL_RESET_CACHE: 42,
  };

  // Statements and databases nobody finalized or closed are released when
  // collected, like Bun's GC finalizers.
  const statementCleanup = new FinalizationRegistry((id) => sql.release(id));
  const databaseCleanup = new FinalizationRegistry((id) => sql.close(id, true));

  // --- binding ---------------------------------------------------------------

  // A JS value as something native.sqlite binds: null, boolean, number,
  // bigint, string or Uint8Array.
  function bindable(value, safeIntegers) {
    if (value === undefined || value === null) return null;
    switch (typeof value) {
      case "boolean":
      case "number":
      case "string":
        return value;
      case "bigint":
        if (safeIntegers && BigInt.asIntN(64, value) !== value) {
          throw new RangeError(`BigInt value '${value}' is out of range`);
        }
        return value;
    }
    if (value instanceof Uint8Array) return value;
    if (isTypedArray(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Binding expected string, TypedArray, boolean, number, bigint or null");
  }

  function missing(name) {
    return new Error(`Missing parameter "${name}"`);
  }

  // Parameter names after the prefix ($, :, @, ?) in strict mode.
  function keyOf(name, strict) {
    return strict ? name.slice(1) : name;
  }

  const isNumber = (key) => /^[0-9]+$/.test(key);

  // Strict mode with `?NNN` parameters: keys are 1-based positions.
  function hasNumberedNames(names, strict) {
    return strict && names.some((name) => name !== null && isNumber(name.slice(1)));
  }

  function numberedKey(name, i) {
    if (name === null) return i;
    const key = name.slice(1);
    return isNumber(key) ? Number(key) - 1 : key;
  }

  // Positional values for an object of named (or indexed) parameters.
  // Missing keys bind NULL, or throw in strict mode.
  function objectValues(target, names, strict, safeIntegers) {
    const numbered = hasNumberedNames(names, strict);
    const onlyIndexed = names.every((name) => name === null);
    return Array.from(names, (name, i) => {
      if (numbered) {
        const key = numberedKey(name, i);
        if (hasOwn(target, key)) return bindable(target[key], safeIntegers);
        throw missing(name === null ? `?${i + 1}` : name);
      }
      const key = name === null ? i : keyOf(name, strict);
      if (hasOwn(target, key)) return bindable(target[key], safeIntegers);
      if (!strict) return null;
      throw missing(onlyIndexed ? i + 1 : key);
    });
  }

  // Positional values for `bindings` (an array or an object of named
  // parameters) given the statement's parameter names (null for `?`).
  function toValues(bindings, names, strict, safeIntegers) {
    if (!isArray(bindings)) {
      if (bindings === null || typeof bindings !== "object") throw new Error("Expected array");
      return objectValues(bindings, names, strict, safeIntegers);
    }
    if (bindings.length === 0) return [];
    if (bindings.length !== names.length) {
      throw new Error(`SQLite query expected ${names.length} values, received ${bindings.length}`);
    }
    return Array.from(bindings, (value) => bindable(value, safeIntegers));
  }

  // Bun's calling convention: `(a, b)` and `([a, b])` bind positionally,
  // `({ $a })` by name. Returns the bindings value, or undefined for none.
  function bindingsOf(args) {
    if (args.length === 0) return undefined;
    const arg0 = args[0];
    if (!isArray(arg0) && (!arg0 || typeof arg0 !== "object" || isTypedArray(arg0))) return args;
    return arg0;
  }

  // --- Statement -------------------------------------------------------------

  class Statement {
    #id;
    // Keeps the Database (and so its connection) alive while this lives.
    #db;
    #names;
    #strict;
    #safeIntegers;
    #proto = null;

    // `params` (from `db.prepare(sql, params)`) are bound right away.
    constructor(id, db, internalFlags, params) {
      this.#id = id;
      this.#db = db;
      this.#names = sql.paramNames(id);
      this.#strict = (internalFlags & kStrictFlag) !== 0;
      this.#safeIntegers = (internalFlags & kSafeIntegersFlag) !== 0;
      statementCleanup.register(this, id);
      if (params === undefined || params === null) return;
      if (typeof params !== "object") throw new TypeError("Expected bindings to be an object or array");
      sql.bind(id, toValues(params, this.#names, this.#strict, this.#safeIntegers));
    }

    // Values to bind for a call's arguments, or undefined to keep the
    // previous bindings.
    #values(args) {
      const bindings = bindingsOf(args);
      if (bindings === undefined) return undefined;
      return toValues(bindings, this.#names, this.#strict, this.#safeIntegers);
    }

    #shape(row) {
      if (this.#proto !== null && row !== null) Object.setPrototypeOf(row, this.#proto);
      return row;
    }

    get(...args) {
      return this.#shape(sql.rows(this.#id, this.#values(args), 0, this.#safeIntegers));
    }

    all(...args) {
      const rows = sql.rows(this.#id, this.#values(args), 1, this.#safeIntegers);
      if (this.#proto !== null) rows.forEach((row) => this.#shape(row));
      return rows;
    }

    values(...args) {
      return sql.rows(this.#id, this.#values(args), 2, this.#safeIntegers);
    }

    raw(...args) {
      return sql.rows(this.#id, this.#values(args), 3, this.#safeIntegers);
    }

    run(...args) {
      const [changes, lastInsertRowid] = sql.run(this.#id, this.#values(args), this.#safeIntegers);
      return { changes, lastInsertRowid };
    }

    *iterate(...args) {
      const values = this.#values(args);
      for (let row = sql.next(this.#id, values, true, this.#safeIntegers); row !== null; row = sql.next(this.#id, undefined, false, this.#safeIntegers)) {
        yield this.#shape(row);
      }
    }

    *[Symbol.iterator]() {
      yield* this.iterate();
    }

    get isFinalized() {
      return sql.isFinalized(this.#id);
    }

    toJSON() {
      return {
        sql: this.toString(),
        isFinalized: this.isFinalized,
        paramsCount: this.paramsCount,
        columnNames: this.columnNames,
      };
    }

    get [Symbol.toStringTag]() {
      return `"${this.toString()}"`;
    }

    toString() {
      return sql.expandedSql(this.#id);
    }

    safeIntegers(updatedValue) {
      if (updatedValue === undefined) return this.#safeIntegers;
      this.#safeIntegers = !!updatedValue;
      return this;
    }

    as(ClassType) {
      if (typeof ClassType !== "function") throw new TypeError("Expected class to be a constructor or undefined");
      this.#proto = ClassType.prototype;
      return this;
    }

    get columnNames() {
      return sql.columns(this.#id);
    }

    get columnTypes() {
      return sql.columnTypes(this.#id);
    }

    get declaredTypes() {
      return sql.declaredTypes(this.#id);
    }

    get paramsCount() {
      return this.#names.length;
    }

    finalize() {
      sql.finalize(this.#id);
    }

    [Symbol.dispose]() {
      if (!this.isFinalized) this.finalize();
    }
  }

  // --- Database --------------------------------------------------------------

  function absolutePath(filename) {
    if (filename.startsWith("/")) return filename;
    return internal.require("path").resolve(filename);
  }

  function isAnyArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return true;
    return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
  }

  function unsupported(what) {
    return new Error(`${what} is not supported in bun.wasm (SQLite is compiled in and WASI has no dlopen)`);
  }

  const cachedCount = Symbol.for("Bun.Database.cache.count");

  class Database {
    #internalFlags = 0;
    #handle;
    #queryCache = new Map();
    filename;

    constructor(filenameGiven, options) {
      if (filenameGiven !== undefined && typeof filenameGiven !== "string") {
        if (!isTypedArray(filenameGiven)) {
          throw new TypeError(`Expected 'filename' to be a string, got '${typeof filenameGiven}'`);
        }
        let readonly = false;
        if (options && typeof options === "object") {
          if (options.strict) this.#internalFlags |= kStrictFlag;
          if (options.safeIntegers) this.#internalFlags |= kSafeIntegersFlag;
          readonly = !!options.readonly;
        }
        this.#handle = sql.deserialize(filenameGiven, readonly);
        this.filename = ":memory:";
        databaseCleanup.register(this, this.#handle, this);
        return;
      }

      const filename = typeof filenameGiven === "string" ? filenameGiven.trim() : ":memory:";
      let flags = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
      if (typeof options === "object" && options) {
        flags = this.#flagsFromOptions(options);
      } else if (typeof options === "number") {
        flags = options;
      }

      const anonymous = filename === "" || filename === ":memory:";
      if (anonymous && (flags & constants.SQLITE_OPEN_READONLY) !== 0) {
        throw new Error("Cannot open an anonymous database in read-only mode.");
      }

      this.#handle = sql.open(anonymous ? ":memory:" : absolutePath(filename), flags);
      this.filename = filename;
      databaseCleanup.register(this, this.#handle, this);
    }

    #flagsFromOptions(options) {
      let flags = 0;
      if (options.readonly) flags = constants.SQLITE_OPEN_READONLY;
      if ("readOnly" in options) throw new TypeError('Misspelled option "readOnly" should be "readonly"');
      if (options.create) flags = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
      if (options.readwrite) flags |= constants.SQLITE_OPEN_READWRITE;
      if (!("strict" in options) && !("safeIntegers" in options)) return flags;
      if (options.safeIntegers) this.#internalFlags |= kSafeIntegersFlag;
      if (options.strict) this.#internalFlags |= kStrictFlag;
      // Only strict/safeIntegers given: open read-write as by default.
      if (flags === 0) flags = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
      return flags;
    }

    get handle() {
      return this.#handle;
    }

    get inTransaction() {
      return sql.inTransaction(this.#handle);
    }

    static open(filename, options) {
      return new Database(filename, options);
    }

    loadExtension() {
      throw new Error("This build of sqlite3 does not support dynamic extension loading");
    }

    serialize(optionalName) {
      const bytes = sql.serialize(this.#handle, optionalName || "main");
      return internal.require("buffer").Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    static deserialize(serialized, options = false) {
      const bytes = isAnyArrayBuffer(serialized) ? new Uint8Array(serialized) : serialized;
      if (typeof options === "boolean") return new Database(bytes, { readonly: options });
      if (options && typeof options === "object") return new Database(bytes, options);
      return new Database(bytes, 0);
    }

    [Symbol.dispose]() {
      this.close(true);
    }

    static setCustomSQLite() {
      throw unsupported("Database.setCustomSQLite");
    }

    fileControl() {
      throw unsupported("Database.fileControl");
    }

    close(throwOnError = false) {
      // Native close finalizes the statements the database owns (query cache
      // and transaction controller).
      this.#queryCache.clear();
      controllers.delete(this);
      databaseCleanup.unregister(this);
      sql.close(this.#handle, !!throwOnError);
    }

    clearQueryCache() {
      this.#queryCache.forEach((stmt) => stmt.finalize());
      this.#queryCache.clear();
    }

    run(query, ...params) {
      const strict = (this.#internalFlags & kStrictFlag) !== 0;
      const safeIntegers = (this.#internalFlags & kSafeIntegersFlag) !== 0;
      const bindings = bindingsOf(params);
      if (bindings !== undefined && (bindings === null || typeof bindings !== "object")) {
        throw new TypeError("Expected bindings to be an object or array");
      }
      const binder = bindings === undefined ? undefined : (names) => toValues(bindings, names, strict, safeIntegers);
      const [changes, lastInsertRowid] = sql.exec(this.#handle, String(query), binder, safeIntegers);
      return { changes, lastInsertRowid };
    }

    prepare(query, params, flags = 0) {
      return new Statement(sql.prepare(this.#handle, String(query), flags || 0, false), this, this.#internalFlags, params);
    }

    [kPrepareOwned](query, flags) {
      return new Statement(sql.prepare(this.#handle, query, flags, true), this, this.#internalFlags);
    }

    static MAX_QUERY_CACHE_SIZE = 20;

    get [cachedCount]() {
      return this.#queryCache.size;
    }

    query(query) {
      if (typeof query !== "string") {
        throw new TypeError(`Expected 'query' to be a string, got '${typeof query}'`);
      }
      if (query.length === 0) throw new Error("SQL query cannot be empty.");

      const cache = this.#queryCache;
      let stmt = cache.get(query);
      if (stmt !== undefined) {
        // LRU: re-insert so the most recently used key is last.
        cache.delete(query);
        if (stmt.isFinalized) stmt = this[kPrepareOwned](query, constants.SQLITE_PREPARE_PERSISTENT);
        cache.set(query, stmt);
        return stmt;
      }

      stmt = this[kPrepareOwned](query, constants.SQLITE_PREPARE_PERSISTENT);
      const max = Database.MAX_QUERY_CACHE_SIZE;
      if (max <= 0) return stmt;
      // Evicted statements stay usable; close() still finalizes them.
      if (cache.size >= max) cache.delete(cache.keys().next().value);
      cache.set(query, stmt);
      return stmt;
    }

    // Transactions follow better-sqlite3's lib/methods/transaction.js, as in Bun.
    transaction(fn, self) {
      if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");

      const controller = getController(this, self);
      const properties = {
        default: { value: wrapTransaction(fn, this, controller.default) },
        deferred: { value: wrapTransaction(fn, this, controller.deferred) },
        immediate: { value: wrapTransaction(fn, this, controller.immediate) },
        exclusive: { value: wrapTransaction(fn, this, controller.exclusive) },
        database: { value: this, enumerable: true },
      };

      defineProperties(properties.default.value, properties);
      defineProperties(properties.deferred.value, properties);
      defineProperties(properties.immediate.value, properties);
      defineProperties(properties.exclusive.value, properties);
      return properties.default.value;
    }
  }

  Database.prototype.exec = Database.prototype.run;

  const controllers = new WeakMap();

  // The database's cached transaction statements.
  function getController(db) {
    const existing = controllers.get(db);
    if (existing) return existing;
    const shared = {
      commit: db[kPrepareOwned]("COMMIT", 0),
      rollback: db[kPrepareOwned]("ROLLBACK", 0),
      savepoint: db[kPrepareOwned]("SAVEPOINT `\t_bs3.\t`", 0),
      release: db[kPrepareOwned]("RELEASE `\t_bs3.\t`", 0),
      rollbackTo: db[kPrepareOwned]("ROLLBACK TO `\t_bs3.\t`", 0),
    };
    const controller = {
      default: Object.assign({ begin: db[kPrepareOwned]("BEGIN", 0) }, shared),
      deferred: Object.assign({ begin: db[kPrepareOwned]("BEGIN DEFERRED", 0) }, shared),
      immediate: Object.assign({ begin: db[kPrepareOwned]("BEGIN IMMEDIATE", 0) }, shared),
      exclusive: Object.assign({ begin: db[kPrepareOwned]("BEGIN EXCLUSIVE", 0) }, shared),
    };
    controllers.set(db, controller);
    return controller;
  }

  // A transaction function: BEGIN/COMMIT at the top level, a savepoint when
  // nested, and a rollback when `fn` throws.
  function wrapTransaction(fn, db, { begin, commit, rollback, savepoint, release, rollbackTo }) {
    return function transaction(...args) {
      const nested = db.inTransaction;
      const before = nested ? savepoint : begin;
      const after = nested ? release : commit;
      const undo = nested ? rollbackTo : rollback;
      try {
        before.run();
        const result = fn.apply(this, args);
        after.run();
        return result;
      } catch (ex) {
        if (db.inTransaction) {
          undo.run();
          if (undo !== rollback) after.run();
        }
        throw ex;
      }
    };
  }

  // Never thrown itself (errors from SQLite are plain Errors named
  // "SQLiteError"); `instanceof` checks the name.
  class SQLiteError extends Error {
    static [Symbol.hasInstance](instance) {
      return instance?.name === "SQLiteError";
    }

    constructor() {
      super();
      throw new Error("SQLiteError can only be constructed by bun:sqlite");
    }
  }

  return {
    __esModule: true,
    Database,
    Statement,
    constants,
    default: Database,
    SQLiteError,
  };
});
