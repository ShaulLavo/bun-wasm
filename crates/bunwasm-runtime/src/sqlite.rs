//! SQLite for `bun:sqlite` (src/js/bun_sqlite.js), as `native.sqlite`.
//!
//! SQLite itself is the amalgamation bundled by `libsqlite3-sys`, compiled for
//! wasm32-wasip1 with wasi-sdk (extra flags: .cargo/config.toml). Connections
//! use the "unix-none" VFS: WASI has no `fcntl` locks, and lock files would be
//! left behind whenever the wasm instance traps, so a database file must not
//! be written by two processes at once.
//!
//! Databases and statements are referenced from JS by numeric handles into a
//! [`Registry`]. The JS side decides what to bind (it maps named parameters to
//! positions and validates BigInt ranges); this side converts plain values to
//! SQLite and rows back to JS, and throws `SQLiteError`s like Bun's
//! JSSQLStatement.cpp.
//!
//! No `RefCell` borrow of the registry is held while JS runs (the `db.run`
//! binder callback), so re-entrant calls cannot panic.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int};
use std::ptr;
use std::rc::Rc;

use libsqlite3_sys as ffi;
use rquickjs::object::Property;
use rquickjs::{Array, BigInt, Ctx, Exception, Function, IntoJs, Object, Result, TypedArray, Value};

use crate::natives::{bytes_of, new_error, set_fn, throw_error};

struct Db {
    /// Null once the connection is closed for good.
    ptr: *mut ffi::sqlite3,
    /// `close()` was called; the connection may still be draining statements
    /// from `db.prepare()`, which stay usable until finalized.
    closed: bool,
}

struct Stmt {
    /// Null once finalized.
    ptr: *mut ffi::sqlite3_stmt,
    db: u32,
    /// Prepared for the database itself (query cache, transactions), so
    /// `close()` finalizes it at once.
    owned: bool,
    finalized_by_close: bool,
    executed: bool,
}

#[derive(Default)]
struct Registry {
    dbs: HashMap<u32, Db>,
    stmts: HashMap<u32, Stmt>,
    next_id: u32,
}

type Shared = Rc<RefCell<Registry>>;

unsafe extern "C" {
    // In the amalgamation, but left out of libsqlite3-sys's bindings.
    fn sqlite3_close_v2(db: *mut ffi::sqlite3) -> c_int;
}

impl Registry {
    fn add_db(&mut self, ptr: *mut ffi::sqlite3) -> u32 {
        self.next_id += 1;
        self.dbs.insert(self.next_id, Db { ptr, closed: false });
        self.next_id
    }

    /// The connection behind an open (not closed) database handle.
    fn open_db(&self, ctx: &Ctx<'_>, id: u32) -> Result<*mut ffi::sqlite3> {
        match self.dbs.get(&id) {
            Some(db) if !db.ptr.is_null() && !db.closed => Ok(db.ptr),
            Some(_) => Err(throw_error(ctx, "Database has closed")),
            None => Err(throw_error(ctx, "Invalid database handle")),
        }
    }

    fn live_stmt(&self, ctx: &Ctx<'_>, id: u32) -> Result<*mut ffi::sqlite3_stmt> {
        match self.stmts.get(&id) {
            Some(s) if !s.ptr.is_null() => Ok(s.ptr),
            Some(s) if s.finalized_by_close => Err(throw_error(ctx, "Database has closed")),
            _ => Err(throw_error(ctx, "Statement has finalized")),
        }
    }

    /// Finalize a statement; a closed database whose last statement this was
    /// is closed for real.
    fn finalize(&mut self, id: u32, by_close: bool) {
        let Some(stmt) = self.stmts.get_mut(&id) else { return };
        if stmt.ptr.is_null() {
            return;
        }
        // SAFETY: a live statement pointer from sqlite3_prepare_v3.
        unsafe { ffi::sqlite3_finalize(stmt.ptr) };
        stmt.ptr = ptr::null_mut();
        stmt.finalized_by_close = by_close;
        let db = stmt.db;
        self.close_if_drained(db);
    }

    fn close_if_drained(&mut self, db_id: u32) {
        let busy = self.stmts.values().any(|s| s.db == db_id && !s.ptr.is_null());
        let Some(db) = self.dbs.get_mut(&db_id) else { return };
        if !db.closed || db.ptr.is_null() || busy {
            return;
        }
        // SAFETY: an open connection; close_v2 also copes with statements
        // SQLite keeps internally (FTS5 caches its own).
        unsafe { sqlite3_close_v2(db.ptr) };
        db.ptr = ptr::null_mut();
    }
}

// --- errors -----------------------------------------------------------------

macro_rules! code_names {
    ($code:expr, $($name:ident),* $(,)?) => {
        match $code {
            $(ffi::$name => Some(stringify!($name)),)*
            _ => None,
        }
    };
}

/// `SQLITE_CONSTRAINT_UNIQUE` and friends for an extended result code.
fn code_name(code: c_int) -> Option<&'static str> {
    code_names!(code,
        SQLITE_ERROR, SQLITE_INTERNAL, SQLITE_PERM, SQLITE_ABORT, SQLITE_BUSY, SQLITE_LOCKED,
        SQLITE_NOMEM, SQLITE_READONLY, SQLITE_INTERRUPT, SQLITE_IOERR, SQLITE_CORRUPT,
        SQLITE_NOTFOUND, SQLITE_FULL, SQLITE_CANTOPEN, SQLITE_PROTOCOL, SQLITE_EMPTY, SQLITE_SCHEMA,
        SQLITE_TOOBIG, SQLITE_CONSTRAINT, SQLITE_MISMATCH, SQLITE_MISUSE, SQLITE_NOLFS, SQLITE_AUTH,
        SQLITE_FORMAT, SQLITE_RANGE, SQLITE_NOTADB, SQLITE_NOTICE, SQLITE_WARNING,
        SQLITE_ERROR_MISSING_COLLSEQ, SQLITE_ERROR_RETRY, SQLITE_ERROR_SNAPSHOT,
        SQLITE_IOERR_READ, SQLITE_IOERR_SHORT_READ, SQLITE_IOERR_WRITE, SQLITE_IOERR_FSYNC,
        SQLITE_IOERR_DIR_FSYNC, SQLITE_IOERR_TRUNCATE, SQLITE_IOERR_FSTAT, SQLITE_IOERR_UNLOCK,
        SQLITE_IOERR_RDLOCK, SQLITE_IOERR_DELETE, SQLITE_IOERR_BLOCKED, SQLITE_IOERR_NOMEM,
        SQLITE_IOERR_ACCESS, SQLITE_IOERR_CHECKRESERVEDLOCK, SQLITE_IOERR_LOCK, SQLITE_IOERR_CLOSE,
        SQLITE_IOERR_DIR_CLOSE, SQLITE_IOERR_SHMOPEN, SQLITE_IOERR_SHMSIZE, SQLITE_IOERR_SHMLOCK,
        SQLITE_IOERR_SHMMAP, SQLITE_IOERR_SEEK, SQLITE_IOERR_DELETE_NOENT, SQLITE_IOERR_MMAP,
        SQLITE_IOERR_GETTEMPPATH, SQLITE_IOERR_CONVPATH, SQLITE_IOERR_VNODE, SQLITE_IOERR_AUTH,
        SQLITE_IOERR_BEGIN_ATOMIC, SQLITE_IOERR_COMMIT_ATOMIC, SQLITE_IOERR_ROLLBACK_ATOMIC,
        SQLITE_IOERR_DATA, SQLITE_IOERR_CORRUPTFS, SQLITE_IOERR_IN_PAGE,
        SQLITE_LOCKED_SHAREDCACHE, SQLITE_LOCKED_VTAB, SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT,
        SQLITE_BUSY_TIMEOUT, SQLITE_CANTOPEN_NOTEMPDIR, SQLITE_CANTOPEN_ISDIR,
        SQLITE_CANTOPEN_FULLPATH, SQLITE_CANTOPEN_CONVPATH, SQLITE_CANTOPEN_DIRTYWAL,
        SQLITE_CANTOPEN_SYMLINK, SQLITE_CORRUPT_VTAB, SQLITE_CORRUPT_SEQUENCE, SQLITE_CORRUPT_INDEX,
        SQLITE_READONLY_RECOVERY, SQLITE_READONLY_CANTLOCK, SQLITE_READONLY_ROLLBACK,
        SQLITE_READONLY_DBMOVED, SQLITE_READONLY_CANTINIT, SQLITE_READONLY_DIRECTORY,
        SQLITE_ABORT_ROLLBACK, SQLITE_CONSTRAINT_CHECK, SQLITE_CONSTRAINT_COMMITHOOK,
        SQLITE_CONSTRAINT_FOREIGNKEY, SQLITE_CONSTRAINT_FUNCTION, SQLITE_CONSTRAINT_NOTNULL,
        SQLITE_CONSTRAINT_PRIMARYKEY, SQLITE_CONSTRAINT_TRIGGER, SQLITE_CONSTRAINT_UNIQUE,
        SQLITE_CONSTRAINT_VTAB, SQLITE_CONSTRAINT_ROWID, SQLITE_CONSTRAINT_PINNED,
        SQLITE_CONSTRAINT_DATATYPE, SQLITE_NOTICE_RECOVER_WAL, SQLITE_NOTICE_RECOVER_ROLLBACK,
        SQLITE_NOTICE_RBU, SQLITE_WARNING_AUTOINDEX, SQLITE_AUTH_USER,
        SQLITE_OK_LOAD_PERMANENTLY, SQLITE_OK_SYMLINK,
    )
}

fn lossy(text: *const c_char) -> String {
    if text.is_null() {
        return String::new();
    }
    // SAFETY: SQLite returns NUL-terminated strings valid until the next call.
    unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned()
}

/// Bun's `SQLiteError` for the connection's last error: the message, a
/// non-enumerable `name`, and `code`, `errno` (extended code) and `byteOffset`.
fn sqlite_error(ctx: &Ctx<'_>, db: *mut ffi::sqlite3) -> rquickjs::Error {
    if db.is_null() {
        return throw_error(ctx, "out of memory");
    }
    // SAFETY: `db` is an open connection.
    let (code, offset, message) = unsafe {
        (ffi::sqlite3_extended_errcode(db), ffi::sqlite3_error_offset(db), lossy(ffi::sqlite3_errmsg(db)))
    };
    let build = || -> Result<Exception<'_>> {
        let err = new_error(ctx, &message)?;
        let obj = err.as_object();
        obj.prop("name", Property::from("SQLiteError").writable().configurable())?;
        if let Some(name) = code_name(code) {
            obj.set("code", name)?;
        }
        obj.set("errno", code)?;
        obj.set("byteOffset", offset)?;
        Ok(err)
    };
    match build() {
        Ok(err) => err.throw(),
        Err(e) => e,
    }
}

// --- values -----------------------------------------------------------------

/// Bind one JS value (already normalized by the JS side: null, boolean,
/// number, bigint, string or Uint8Array) to parameter `index` (1-based).
fn bind_value(ctx: &Ctx<'_>, stmt: *mut ffi::sqlite3_stmt, index: c_int, value: &Value<'_>) -> Result<()> {
    // SAFETY (all binds): `stmt` is live; SQLITE_TRANSIENT makes SQLite copy
    // text and blobs before returning.
    let rc = if value.is_null() || value.is_undefined() {
        unsafe { ffi::sqlite3_bind_null(stmt, index) }
    } else if let Some(b) = value.as_bool() {
        unsafe { ffi::sqlite3_bind_int(stmt, index, b as c_int) }
    } else if let Some(i) = value.as_int() {
        unsafe { ffi::sqlite3_bind_int64(stmt, index, i64::from(i)) }
    } else if let Some(f) = value.as_float() {
        // Integral doubles bind as INTEGER like in JavaScriptCore (`isAnyInt`),
        // except -0, which only a REAL can hold.
        let integral = f.fract() == 0.0 && f.abs() < 9007199254740992.0 && !(f == 0.0 && f.is_sign_negative());
        match integral {
            true => unsafe { ffi::sqlite3_bind_int64(stmt, index, f as i64) },
            false => unsafe { ffi::sqlite3_bind_double(stmt, index, f) },
        }
    } else if let Some(big) = value.as_big_int() {
        // Wraps modulo 2^64 like BigInt.asIntN(64, n); the JS side range-checks
        // under safeIntegers.
        let n = big.clone().to_i64()?;
        unsafe { ffi::sqlite3_bind_int64(stmt, index, n) }
    } else if let Some(s) = value.as_string() {
        let text = s.to_string()?;
        unsafe {
            ffi::sqlite3_bind_text64(
                stmt,
                index,
                text.as_ptr().cast(),
                text.len() as u64,
                ffi::SQLITE_TRANSIENT(),
                ffi::SQLITE_UTF8 as u8,
            )
        }
    } else if value.is_object() {
        let bytes = bytes_of(value)?;
        // An empty pointer would bind NULL; "" binds a zero-length BLOB.
        let data = if bytes.is_empty() { c"".as_ptr().cast() } else { bytes.as_ptr().cast() };
        unsafe { ffi::sqlite3_bind_blob64(stmt, index, data, bytes.len() as u64, ffi::SQLITE_TRANSIENT()) }
    } else {
        return Err(Exception::throw_type(ctx, "Binding expected string, TypedArray, boolean, number, bigint or null"));
    };
    if rc != ffi::SQLITE_OK {
        // SAFETY: a live statement belongs to an open connection.
        let db = unsafe { ffi::sqlite3_db_handle(stmt) };
        return Err(throw_error(ctx, &lossy(unsafe { ffi::sqlite3_errmsg(db) })));
    }
    Ok(())
}

/// Clear the bindings and bind `values` positionally.
fn bind_all(ctx: &Ctx<'_>, stmt: *mut ffi::sqlite3_stmt, values: &Array<'_>) -> Result<()> {
    // SAFETY: `stmt` is live.
    unsafe { ffi::sqlite3_clear_bindings(stmt) };
    for (i, value) in values.iter::<Value>().enumerate() {
        bind_value(ctx, stmt, i as c_int + 1, &value?)?;
    }
    Ok(())
}

fn integer<'js>(ctx: &Ctx<'js>, n: i64, safe: bool) -> Result<Value<'js>> {
    match safe {
        true => BigInt::from_i64(ctx.clone(), n).map(|b| b.into_value()),
        false => Ok(Value::new_number(ctx.clone(), n as f64)),
    }
}

/// Column `i` of the current row.
fn column<'js>(ctx: &Ctx<'js>, stmt: *mut ffi::sqlite3_stmt, i: c_int, safe: bool) -> Result<Value<'js>> {
    // SAFETY: `stmt` is live and positioned on a row; text and blob pointers
    // are copied before the next SQLite call.
    unsafe {
        match ffi::sqlite3_column_type(stmt, i) {
            ffi::SQLITE_INTEGER => integer(ctx, ffi::sqlite3_column_int64(stmt, i), safe),
            ffi::SQLITE_FLOAT => Ok(Value::new_float(ctx.clone(), ffi::sqlite3_column_double(stmt, i))),
            ffi::SQLITE_TEXT => {
                let data = ffi::sqlite3_column_text(stmt, i);
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                let bytes = if data.is_null() { &[][..] } else { std::slice::from_raw_parts(data, len) };
                String::from_utf8_lossy(bytes).into_js(ctx)
            }
            ffi::SQLITE_BLOB => {
                let data = ffi::sqlite3_column_blob(stmt, i).cast::<u8>();
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                let bytes = if data.is_null() { Vec::new() } else { std::slice::from_raw_parts(data, len).to_vec() };
                TypedArray::<u8>::new(ctx.clone(), bytes).map(|a| a.into_value())
            }
            _ => Ok(Value::new_null(ctx.clone())),
        }
    }
}

/// Column `i` of the current row as its bytes (`stmt.raw()`): integers and
/// floats as 8 little-endian bytes, text as UTF-8, NULL as null.
fn raw_column<'js>(ctx: &Ctx<'js>, stmt: *mut ffi::sqlite3_stmt, i: c_int) -> Result<Value<'js>> {
    // SAFETY: as in `column`.
    let bytes = unsafe {
        match ffi::sqlite3_column_type(stmt, i) {
            ffi::SQLITE_INTEGER => ffi::sqlite3_column_int64(stmt, i).to_le_bytes().to_vec(),
            ffi::SQLITE_FLOAT => ffi::sqlite3_column_double(stmt, i).to_le_bytes().to_vec(),
            ffi::SQLITE_TEXT | ffi::SQLITE_BLOB => {
                let data = ffi::sqlite3_column_blob(stmt, i).cast::<u8>();
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                if data.is_null() { Vec::new() } else { std::slice::from_raw_parts(data, len).to_vec() }
            }
            _ => return Ok(Value::new_null(ctx.clone())),
        }
    };
    TypedArray::<u8>::new(ctx.clone(), bytes).map(|a| a.into_value())
}

fn column_names(stmt: *mut ffi::sqlite3_stmt) -> Vec<String> {
    // SAFETY: `stmt` is live.
    let count = unsafe { ffi::sqlite3_column_count(stmt) };
    (0..count).map(|i| lossy(unsafe { ffi::sqlite3_column_name(stmt, i) })).collect()
}

/// How rows come back to JS.
#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Object,
    Array,
    /// Arrays of byte buffers.
    Raw,
}

fn row<'js>(ctx: &Ctx<'js>, stmt: *mut ffi::sqlite3_stmt, names: &[String], shape: Shape, safe: bool) -> Result<Value<'js>> {
    if shape != Shape::Object {
        let arr = Array::new(ctx.clone())?;
        for i in 0..names.len() {
            let value = match shape {
                Shape::Raw => raw_column(ctx, stmt, i as c_int)?,
                _ => column(ctx, stmt, i as c_int, safe)?,
            };
            arr.set(i, value)?;
        }
        return Ok(arr.into_value());
    }
    // Later duplicate column names overwrite earlier ones, as in Bun.
    let obj = Object::new(ctx.clone())?;
    for (i, name) in names.iter().enumerate() {
        obj.set(name.as_str(), column(ctx, stmt, i as c_int, safe)?)?;
    }
    Ok(obj.into_value())
}

/// Step once; `Ok(true)` when a row is available. Errors reset the statement
/// so it can run again.
fn step(ctx: &Ctx<'_>, stmt: *mut ffi::sqlite3_stmt) -> Result<bool> {
    // SAFETY: `stmt` is live.
    match unsafe { ffi::sqlite3_step(stmt) } {
        ffi::SQLITE_ROW => Ok(true),
        ffi::SQLITE_DONE => Ok(false),
        _ => {
            let db = unsafe { ffi::sqlite3_db_handle(stmt) };
            let err = sqlite_error(ctx, db);
            unsafe { ffi::sqlite3_reset(stmt) };
            Err(err)
        }
    }
}

fn changes<'js>(ctx: &Ctx<'js>, db: *mut ffi::sqlite3, before: i64, safe: bool) -> Result<Array<'js>> {
    // SAFETY: `db` is open.
    let (after, rowid) = unsafe { (ffi::sqlite3_total_changes64(db), ffi::sqlite3_last_insert_rowid(db)) };
    let out = Array::new(ctx.clone())?;
    out.set(0, (after - before) as f64)?;
    out.set(1, integer(ctx, rowid, safe)?)?;
    Ok(out)
}

// --- natives ----------------------------------------------------------------

/// Prepare one statement; null when `sql` holds none (blank or a comment).
fn prepare_raw(ctx: &Ctx<'_>, db: *mut ffi::sqlite3, sql: &str, flags: u32) -> Result<*mut ffi::sqlite3_stmt> {
    let mut stmt = ptr::null_mut();
    // SAFETY: `db` is open; SQLite reads `sql.len()` bytes.
    let rc = unsafe {
        ffi::sqlite3_prepare_v3(db, sql.as_ptr().cast(), sql.len() as c_int, flags, &mut stmt, ptr::null_mut())
    };
    if rc != ffi::SQLITE_OK {
        return Err(sqlite_error(ctx, db));
    }
    Ok(stmt)
}

/// Finalizes a one-off statement of `db.run` on every exit path.
struct Transient(*mut ffi::sqlite3_stmt);

impl Drop for Transient {
    fn drop(&mut self) {
        // SAFETY: finalize accepts null and live statements.
        unsafe { ffi::sqlite3_finalize(self.0) };
    }
}

/// `db.run(sql, ...)`: every statement in `sql` in turn. `binder(names)`
/// returns the positional values for the first statement's parameters.
fn exec<'js>(ctx: &Ctx<'js>, reg: &Shared, id: u32, sql: &str, binder: Option<Function<'js>>, safe: bool) -> Result<Array<'js>> {
    let db = reg.borrow().open_db(ctx, id)?;
    if sql.is_empty() {
        return Err(throw_error(ctx, "SQL string mustn't be blank"));
    }
    let skipped = |c: u8| c == b' ' || c == b';' || (b'\t'..=b'\r').contains(&c);
    // SAFETY: `db` is open.
    let before = unsafe { ffi::sqlite3_total_changes64(db) };
    let bytes = sql.as_bytes();
    let mut offset = 0;
    let mut binder = binder;
    let mut executed = false;
    while offset < bytes.len() {
        while offset < bytes.len() && skipped(bytes[offset]) {
            offset += 1;
        }
        if offset == bytes.len() {
            break;
        }
        let rest = &bytes[offset..];
        let mut stmt = ptr::null_mut();
        let mut tail: *const c_char = ptr::null();
        // SAFETY: `db` is open; SQLite reads `rest.len()` bytes and points
        // `tail` into them.
        let rc = unsafe { ffi::sqlite3_prepare_v3(db, rest.as_ptr().cast(), rest.len() as c_int, 0, &mut stmt, &mut tail) };
        if rc != ffi::SQLITE_OK {
            return Err(sqlite_error(ctx, db));
        }
        let consumed = (tail as usize).saturating_sub(rest.as_ptr() as usize);
        let guard = Transient(stmt);
        if stmt.is_null() {
            // A comment or other text without a statement.
            if consumed == 0 {
                break;
            }
            offset += consumed;
            continue;
        }
        if let Some(bind) = binder.take() {
            let values: Array = bind.call((param_names(ctx, stmt)?,))?;
            // The binder ran JS, which may have closed the database.
            reg.borrow().open_db(ctx, id)?;
            bind_all(ctx, stmt, &values)?;
        }
        while step(ctx, guard.0)? {}
        executed = true;
        offset += consumed.max(1);
    }
    if !executed {
        return Err(throw_error(ctx, "Query contained no valid SQL statement; likely empty query."));
    }
    changes(ctx, db, before, safe)
}

fn param_names<'js>(ctx: &Ctx<'js>, stmt: *mut ffi::sqlite3_stmt) -> Result<Array<'js>> {
    let out = Array::new(ctx.clone())?;
    // SAFETY: `stmt` is live.
    let count = unsafe { ffi::sqlite3_bind_parameter_count(stmt) };
    for i in 1..=count {
        let name = unsafe { ffi::sqlite3_bind_parameter_name(stmt, i) };
        match name.is_null() {
            true => out.set(i as usize - 1, Value::new_null(ctx.clone()))?,
            false => out.set(i as usize - 1, lossy(name))?,
        }
    }
    Ok(out)
}

fn type_name(kind: c_int) -> &'static str {
    match kind {
        ffi::SQLITE_INTEGER => "INTEGER",
        ffi::SQLITE_FLOAT => "FLOAT",
        ffi::SQLITE_TEXT => "TEXT",
        ffi::SQLITE_BLOB => "BLOB",
        _ => "NULL",
    }
}

pub fn install<'js>(native: &Object<'js>) -> Result<()> {
    let ctx = native.ctx().clone();
    let sqlite = Object::new(ctx)?;
    let reg: Shared = Rc::default();
    install_databases(&sqlite, &reg)?;
    install_statements(&sqlite, &reg)?;
    native.set("sqlite", sqlite)
}

fn install_databases<'js>(sqlite: &Object<'js>, reg: &Shared) -> Result<()> {
    let r = reg.clone();
    set_fn(sqlite, "open", move |ctx: Ctx<'js>, path: String, flags: i32| -> Result<u32> {
        let path = CString::new(path).map_err(|_| Exception::throw_type(&ctx, "Expected a path without NUL bytes"))?;
        let mut db = ptr::null_mut();
        // SAFETY: valid C strings; `db` receives a connection (even on error).
        let rc = unsafe { ffi::sqlite3_open_v2(path.as_ptr(), &mut db, flags, c"unix-none".as_ptr()) };
        if rc != ffi::SQLITE_OK {
            let err = sqlite_error(&ctx, db);
            unsafe { sqlite3_close_v2(db) };
            return Err(err);
        }
        // SAFETY: `db` is open.
        unsafe {
            ffi::sqlite3_extended_result_codes(db, 1);
            ffi::sqlite3_db_config(db, ffi::SQLITE_DBCONFIG_DEFENSIVE, 1, ptr::null_mut::<c_int>());
        }
        Ok(r.borrow_mut().add_db(db))
    })?;
    let r = reg.clone();
    set_fn(sqlite, "deserialize", move |ctx: Ctx<'js>, data: Value<'js>, readonly: bool| -> Result<u32> {
        let bytes = bytes_of(&data)?;
        if bytes.is_empty() {
            return Err(throw_error(&ctx, "ArrayBuffer must not be empty"));
        }
        let mut db = ptr::null_mut();
        // SAFETY: opens an empty in-memory database, then hands it a copy of
        // the image in SQLite's own allocation (freed on close).
        unsafe {
            if ffi::sqlite3_open_v2(c":memory:".as_ptr(), &mut db, ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE, ptr::null()) != ffi::SQLITE_OK {
                sqlite3_close_v2(db);
                return Err(throw_error(&ctx, "Failed to open SQLite"));
            }
            let image = ffi::sqlite3_malloc64(bytes.len() as u64).cast::<u8>();
            if image.is_null() {
                sqlite3_close_v2(db);
                return Err(throw_error(&ctx, "Failed to allocate memory"));
            }
            ptr::copy_nonoverlapping(bytes.as_ptr(), image, bytes.len());
            let mut flags = ffi::SQLITE_DESERIALIZE_FREEONCLOSE | ffi::SQLITE_DESERIALIZE_RESIZEABLE;
            if readonly {
                flags |= ffi::SQLITE_DESERIALIZE_READONLY;
            }
            let len = bytes.len() as i64;
            if ffi::sqlite3_deserialize(db, c"main".as_ptr(), image, len, len, flags as u32) != ffi::SQLITE_OK {
                let err = sqlite_error(&ctx, db);
                sqlite3_close_v2(db);
                return Err(err);
            }
            ffi::sqlite3_extended_result_codes(db, 1);
        }
        Ok(r.borrow_mut().add_db(db))
    })?;
    let r = reg.clone();
    set_fn(sqlite, "serialize", move |ctx: Ctx<'js>, id: u32, schema: String| -> Result<Value<'js>> {
        let db = r.borrow().open_db(&ctx, id)?;
        let schema = CString::new(schema).map_err(|_| Exception::throw_type(&ctx, "Expected a schema name"))?;
        let mut size: i64 = 0;
        // SAFETY: `db` is open; the returned buffer is ours to free.
        let bytes = unsafe {
            let data = ffi::sqlite3_serialize(db, schema.as_ptr(), &mut size, 0);
            if data.is_null() {
                return Err(throw_error(&ctx, "Out of memory"));
            }
            let bytes = std::slice::from_raw_parts(data, size as usize).to_vec();
            ffi::sqlite3_free(data.cast());
            bytes
        };
        TypedArray::<u8>::new(ctx.clone(), bytes).map(|a| a.into_value())
    })?;
    let r = reg.clone();
    set_fn(sqlite, "close", move |ctx: Ctx<'js>, id: u32, force: bool| -> Result<()> {
        let mut reg = r.borrow_mut();
        let Some(db) = reg.dbs.get_mut(&id) else {
            return Err(throw_error(&ctx, "Invalid database handle"));
        };
        if db.ptr.is_null() || (db.closed && !force) {
            return Ok(());
        }
        db.closed = true;
        // close(false) keeps db.prepare() statements usable; the connection
        // closes once they are finalized. close(true) finalizes everything.
        let doomed: Vec<u32> = reg
            .stmts
            .iter()
            .filter(|(_, s)| s.db == id && !s.ptr.is_null() && (force || s.owned))
            .map(|(k, _)| *k)
            .collect();
        for stmt in doomed {
            reg.finalize(stmt, true);
        }
        reg.close_if_drained(id);
        Ok(())
    })?;
    let r = reg.clone();
    set_fn(sqlite, "inTransaction", move |ctx: Ctx<'js>, id: u32| -> Result<bool> {
        let db = r.borrow().open_db(&ctx, id)?;
        // SAFETY: `db` is open.
        Ok(unsafe { ffi::sqlite3_get_autocommit(db) } == 0)
    })?;
    let r = reg.clone();
    set_fn(sqlite, "exec", move |ctx: Ctx<'js>, id: u32, sql: String, binder: Option<Function<'js>>, safe: bool| {
        exec(&ctx, &r, id, &sql, binder, safe)
    })?;
    let r = reg.clone();
    set_fn(sqlite, "prepare", move |ctx: Ctx<'js>, id: u32, sql: String, flags: u32, owned: bool| -> Result<u32> {
        let db = r.borrow().open_db(&ctx, id).map_err(|_| Exception::throw_range(&ctx, "Cannot use a closed database"))?;
        let stmt = prepare_raw(&ctx, db, &sql, flags)?;
        if stmt.is_null() {
            return Err(Exception::throw_range(&ctx, "Invalid SQL statement"));
        }
        let mut reg = r.borrow_mut();
        reg.next_id += 1;
        let handle = reg.next_id;
        reg.stmts.insert(handle, Stmt { ptr: stmt, db: id, owned, finalized_by_close: false, executed: false });
        Ok(handle)
    })?;
    Ok(())
}

/// Reset `id` and, when given, bind `values`; marks it executed.
fn start(ctx: &Ctx<'_>, reg: &Shared, id: u32, values: Option<Array<'_>>) -> Result<*mut ffi::sqlite3_stmt> {
    let stmt = reg.borrow().live_stmt(ctx, id)?;
    // SAFETY: `stmt` is live.
    unsafe { ffi::sqlite3_reset(stmt) };
    if let Some(values) = values {
        bind_all(ctx, stmt, &values)?;
    }
    if let Some(s) = reg.borrow_mut().stmts.get_mut(&id) {
        s.executed = true;
    }
    Ok(stmt)
}

fn install_statements<'js>(sqlite: &Object<'js>, reg: &Shared) -> Result<()> {
    let r = reg.clone();
    // get() / all() / values() / raw(): mode 0 = first row object (or null),
    // 1 = row objects, 2 = row arrays, 3 = row arrays of bytes (2 and 3 give
    // null for statements without columns).
    set_fn(sqlite, "rows", move |ctx: Ctx<'js>, id: u32, values: Option<Array<'js>>, mode: u32, safe: bool| -> Result<Value<'js>> {
        let stmt = start(&ctx, &r, id, values)?;
        let names = column_names(stmt);
        if mode == 0 {
            let found = step(&ctx, stmt)?;
            let result = match found && !names.is_empty() {
                true => row(&ctx, stmt, &names, Shape::Object, safe)?,
                false => Value::new_null(ctx.clone()),
            };
            // Release read locks. INSERT ... RETURNING has done all its work
            // by the first row.
            unsafe { ffi::sqlite3_reset(stmt) };
            return Ok(result);
        }
        let shape = match mode {
            2 => Shape::Array,
            3 => Shape::Raw,
            _ => Shape::Object,
        };
        let out = Array::new(ctx.clone())?;
        let mut n = 0;
        while step(&ctx, stmt)? {
            if names.is_empty() {
                continue;
            }
            out.set(n, row(&ctx, stmt, &names, shape, safe)?)?;
            n += 1;
        }
        unsafe { ffi::sqlite3_reset(stmt) };
        if names.is_empty() && shape != Shape::Object {
            return Ok(Value::new_null(ctx.clone()));
        }
        Ok(out.into_value())
    })?;
    let r = reg.clone();
    // iterate(): the next row object, or null at the end. `first` starts over.
    set_fn(sqlite, "next", move |ctx: Ctx<'js>, id: u32, values: Option<Array<'js>>, first: bool, safe: bool| -> Result<Value<'js>> {
        let stmt = match first {
            true => start(&ctx, &r, id, values)?,
            false => r.borrow().live_stmt(&ctx, id)?,
        };
        if !step(&ctx, stmt)? {
            unsafe { ffi::sqlite3_reset(stmt) };
            return Ok(Value::new_null(ctx.clone()));
        }
        row(&ctx, stmt, &column_names(stmt), Shape::Object, safe)
    })?;
    let r = reg.clone();
    set_fn(sqlite, "run", move |ctx: Ctx<'js>, id: u32, values: Option<Array<'js>>, safe: bool| -> Result<Array<'js>> {
        let stmt = start(&ctx, &r, id, values)?;
        // SAFETY: a live statement belongs to an open connection.
        let db = unsafe { ffi::sqlite3_db_handle(stmt) };
        let before = unsafe { ffi::sqlite3_total_changes64(db) };
        while step(&ctx, stmt)? {}
        unsafe { ffi::sqlite3_reset(stmt) };
        changes(&ctx, db, before, safe)
    })?;
    let r = reg.clone();
    set_fn(sqlite, "bind", move |ctx: Ctx<'js>, id: u32, values: Array<'js>| -> Result<()> {
        start(&ctx, &r, id, Some(values)).map(|_| ())
    })?;
    let r = reg.clone();
    set_fn(sqlite, "paramNames", move |ctx: Ctx<'js>, id: u32| -> Result<Array<'js>> {
        let stmt = r.borrow().live_stmt(&ctx, id)?;
        param_names(&ctx, stmt)
    })?;
    let r = reg.clone();
    set_fn(sqlite, "columns", move |ctx: Ctx<'js>, id: u32| -> Result<Vec<String>> {
        let stmt = r.borrow().live_stmt(&ctx, id)?;
        Ok(column_names(stmt))
    })?;
    let r = reg.clone();
    set_fn(sqlite, "columnTypes", move |ctx: Ctx<'js>, id: u32| -> Result<Vec<&'static str>> {
        let stmt = r.borrow().live_stmt(&ctx, id)?;
        // SAFETY: `stmt` is live.
        if unsafe { ffi::sqlite3_stmt_readonly(stmt) } == 0 {
            return Err(throw_error(
                &ctx,
                "columnTypes is not available for non-read-only statements (INSERT, UPDATE, DELETE, etc.)",
            ));
        }
        // Types of the first row: safe to step a read-only statement.
        let count = unsafe { ffi::sqlite3_column_count(stmt) };
        unsafe { ffi::sqlite3_reset(stmt) };
        let found = step(&ctx, stmt)?;
        let types = (0..count)
            .map(|i| if found { type_name(unsafe { ffi::sqlite3_column_type(stmt, i) }) } else { "NULL" })
            .collect();
        unsafe { ffi::sqlite3_reset(stmt) };
        Ok(types)
    })?;
    let r = reg.clone();
    set_fn(sqlite, "declaredTypes", move |ctx: Ctx<'js>, id: u32| -> Result<Vec<Value<'js>>> {
        let stmt = r.borrow().live_stmt(&ctx, id)?;
        if !r.borrow().stmts.get(&id).is_some_and(|s| s.executed) {
            return Err(throw_error(&ctx, "Statement must be executed before accessing declaredTypes"));
        }
        // SAFETY: `stmt` is live.
        let count = unsafe { ffi::sqlite3_column_count(stmt) };
        (0..count)
            .map(|i| {
                let decl = unsafe { ffi::sqlite3_column_decltype(stmt, i) };
                match decl.is_null() {
                    true => Ok(Value::new_null(ctx.clone())),
                    false => lossy(decl).into_js(&ctx),
                }
            })
            .collect()
    })?;
    let r = reg.clone();
    set_fn(sqlite, "paramsCount", move |ctx: Ctx<'js>, id: u32| -> Result<i32> {
        let stmt = r.borrow().live_stmt(&ctx, id)?;
        // SAFETY: `stmt` is live.
        Ok(unsafe { ffi::sqlite3_bind_parameter_count(stmt) })
    })?;
    let r = reg.clone();
    set_fn(sqlite, "expandedSql", move |ctx: Ctx<'js>, id: u32| -> Result<String> {
        let stmt = r.borrow().live_stmt(&ctx, id)?;
        // SAFETY: `stmt` is live; the expanded text is ours to free.
        unsafe {
            let text = ffi::sqlite3_expanded_sql(stmt);
            let sql = lossy(text);
            ffi::sqlite3_free(text.cast());
            Ok(sql)
        }
    })?;
    let r = reg.clone();
    set_fn(sqlite, "isFinalized", move |id: u32| -> bool {
        r.borrow().stmts.get(&id).is_none_or(|s| s.ptr.is_null())
    })?;
    let r = reg.clone();
    set_fn(sqlite, "finalize", move |id: u32| {
        r.borrow_mut().finalize(id, false);
    })?;
    let r = reg.clone();
    // FinalizationRegistry callback for statements that were never finalized.
    set_fn(sqlite, "release", move |id: u32| {
        let mut reg = r.borrow_mut();
        reg.finalize(id, false);
        reg.stmts.remove(&id);
    })?;
    Ok(())
}
