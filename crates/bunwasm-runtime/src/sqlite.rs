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

use crate::engine::{Args, NativeError, NativeResult, Val};
use crate::natives::Table;

type Result<T> = std::result::Result<T, NativeError>;

fn throw_error(message: &str) -> NativeError {
    NativeError::error(message)
}

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
    fn open_db(&self, id: u32) -> Result<*mut ffi::sqlite3> {
        match self.dbs.get(&id) {
            Some(db) if !db.ptr.is_null() && !db.closed => Ok(db.ptr),
            Some(_) => Err(throw_error("Database has closed")),
            None => Err(throw_error("Invalid database handle")),
        }
    }

    fn live_stmt(&self, id: u32) -> Result<*mut ffi::sqlite3_stmt> {
        match self.stmts.get(&id) {
            Some(s) if !s.ptr.is_null() => Ok(s.ptr),
            Some(s) if s.finalized_by_close => Err(throw_error("Database has closed")),
            _ => Err(throw_error("Statement has finalized")),
        }
    }

    /// Finalize a statement; a closed database whose last statement this was
    /// is closed for real.
    fn finalize(&mut self, id: u32, by_close: bool) {
        let Some(stmt) = self.stmts.get_mut(&id) else {
            return;
        };
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
        let busy = self
            .stmts
            .values()
            .any(|s| s.db == db_id && !s.ptr.is_null());
        let Some(db) = self.dbs.get_mut(&db_id) else {
            return;
        };
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
    code_names!(
        code,
        SQLITE_ERROR,
        SQLITE_INTERNAL,
        SQLITE_PERM,
        SQLITE_ABORT,
        SQLITE_BUSY,
        SQLITE_LOCKED,
        SQLITE_NOMEM,
        SQLITE_READONLY,
        SQLITE_INTERRUPT,
        SQLITE_IOERR,
        SQLITE_CORRUPT,
        SQLITE_NOTFOUND,
        SQLITE_FULL,
        SQLITE_CANTOPEN,
        SQLITE_PROTOCOL,
        SQLITE_EMPTY,
        SQLITE_SCHEMA,
        SQLITE_TOOBIG,
        SQLITE_CONSTRAINT,
        SQLITE_MISMATCH,
        SQLITE_MISUSE,
        SQLITE_NOLFS,
        SQLITE_AUTH,
        SQLITE_FORMAT,
        SQLITE_RANGE,
        SQLITE_NOTADB,
        SQLITE_NOTICE,
        SQLITE_WARNING,
        SQLITE_ERROR_MISSING_COLLSEQ,
        SQLITE_ERROR_RETRY,
        SQLITE_ERROR_SNAPSHOT,
        SQLITE_IOERR_READ,
        SQLITE_IOERR_SHORT_READ,
        SQLITE_IOERR_WRITE,
        SQLITE_IOERR_FSYNC,
        SQLITE_IOERR_DIR_FSYNC,
        SQLITE_IOERR_TRUNCATE,
        SQLITE_IOERR_FSTAT,
        SQLITE_IOERR_UNLOCK,
        SQLITE_IOERR_RDLOCK,
        SQLITE_IOERR_DELETE,
        SQLITE_IOERR_BLOCKED,
        SQLITE_IOERR_NOMEM,
        SQLITE_IOERR_ACCESS,
        SQLITE_IOERR_CHECKRESERVEDLOCK,
        SQLITE_IOERR_LOCK,
        SQLITE_IOERR_CLOSE,
        SQLITE_IOERR_DIR_CLOSE,
        SQLITE_IOERR_SHMOPEN,
        SQLITE_IOERR_SHMSIZE,
        SQLITE_IOERR_SHMLOCK,
        SQLITE_IOERR_SHMMAP,
        SQLITE_IOERR_SEEK,
        SQLITE_IOERR_DELETE_NOENT,
        SQLITE_IOERR_MMAP,
        SQLITE_IOERR_GETTEMPPATH,
        SQLITE_IOERR_CONVPATH,
        SQLITE_IOERR_VNODE,
        SQLITE_IOERR_AUTH,
        SQLITE_IOERR_BEGIN_ATOMIC,
        SQLITE_IOERR_COMMIT_ATOMIC,
        SQLITE_IOERR_ROLLBACK_ATOMIC,
        SQLITE_IOERR_DATA,
        SQLITE_IOERR_CORRUPTFS,
        SQLITE_IOERR_IN_PAGE,
        SQLITE_LOCKED_SHAREDCACHE,
        SQLITE_LOCKED_VTAB,
        SQLITE_BUSY_RECOVERY,
        SQLITE_BUSY_SNAPSHOT,
        SQLITE_BUSY_TIMEOUT,
        SQLITE_CANTOPEN_NOTEMPDIR,
        SQLITE_CANTOPEN_ISDIR,
        SQLITE_CANTOPEN_FULLPATH,
        SQLITE_CANTOPEN_CONVPATH,
        SQLITE_CANTOPEN_DIRTYWAL,
        SQLITE_CANTOPEN_SYMLINK,
        SQLITE_CORRUPT_VTAB,
        SQLITE_CORRUPT_SEQUENCE,
        SQLITE_CORRUPT_INDEX,
        SQLITE_READONLY_RECOVERY,
        SQLITE_READONLY_CANTLOCK,
        SQLITE_READONLY_ROLLBACK,
        SQLITE_READONLY_DBMOVED,
        SQLITE_READONLY_CANTINIT,
        SQLITE_READONLY_DIRECTORY,
        SQLITE_ABORT_ROLLBACK,
        SQLITE_CONSTRAINT_CHECK,
        SQLITE_CONSTRAINT_COMMITHOOK,
        SQLITE_CONSTRAINT_FOREIGNKEY,
        SQLITE_CONSTRAINT_FUNCTION,
        SQLITE_CONSTRAINT_NOTNULL,
        SQLITE_CONSTRAINT_PRIMARYKEY,
        SQLITE_CONSTRAINT_TRIGGER,
        SQLITE_CONSTRAINT_UNIQUE,
        SQLITE_CONSTRAINT_VTAB,
        SQLITE_CONSTRAINT_ROWID,
        SQLITE_CONSTRAINT_PINNED,
        SQLITE_CONSTRAINT_DATATYPE,
        SQLITE_NOTICE_RECOVER_WAL,
        SQLITE_NOTICE_RECOVER_ROLLBACK,
        SQLITE_NOTICE_RBU,
        SQLITE_WARNING_AUTOINDEX,
        SQLITE_AUTH_USER,
        SQLITE_OK_LOAD_PERMANENTLY,
        SQLITE_OK_SYMLINK,
    )
}

fn lossy(text: *const c_char) -> String {
    if text.is_null() {
        return String::new();
    }
    // SAFETY: SQLite returns NUL-terminated strings valid until the next call.
    unsafe { CStr::from_ptr(text) }
        .to_string_lossy()
        .into_owned()
}

/// Bun's `SQLiteError` for the connection's last error: the message, a
/// non-enumerable `name`, and `code`, `errno` (extended code) and `byteOffset`.
fn sqlite_error(db: *mut ffi::sqlite3) -> NativeError {
    if db.is_null() {
        return throw_error("out of memory");
    }
    // SAFETY: `db` is a connection handle (open or failed to open).
    let (code, offset, message) = unsafe {
        (
            ffi::sqlite3_extended_errcode(db),
            ffi::sqlite3_error_offset(db),
            lossy(ffi::sqlite3_errmsg(db)),
        )
    };
    let mut err = NativeError::error(message).named("SQLiteError");
    if let Some(name) = code_name(code) {
        err = err.prop("code", name);
    }
    err.prop("errno", code).prop("byteOffset", offset)
}

// --- values -----------------------------------------------------------------

/// Bind one JS value (already normalized by the JS side: null, boolean,
/// number, bigint, string or Uint8Array) to parameter `index` (1-based).
fn bind_value(stmt: *mut ffi::sqlite3_stmt, index: c_int, value: &Val) -> Result<()> {
    // SAFETY (all binds): `stmt` is live; text and blobs are copied
    // (SQLITE_TRANSIENT).
    let rc = match value {
        Val::Null | Val::Undefined => unsafe { ffi::sqlite3_bind_null(stmt, index) },
        Val::Bool(b) => unsafe { ffi::sqlite3_bind_int(stmt, index, *b as c_int) },
        Val::Num(f) => {
            let f = *f;
            let integral = f.fract() == 0.0
                && f.abs() < 9007199254740992.0
                && !(f == 0.0 && f.is_sign_negative());
            match integral {
                true => unsafe { ffi::sqlite3_bind_int64(stmt, index, f as i64) },
                false => unsafe { ffi::sqlite3_bind_double(stmt, index, f) },
            }
        }
        Val::BigInt(n) => unsafe { ffi::sqlite3_bind_int64(stmt, index, *n) },
        Val::BigUint(n) => unsafe { ffi::sqlite3_bind_int64(stmt, index, *n as i64) },
        Val::Str(text) => unsafe {
            ffi::sqlite3_bind_text64(
                stmt,
                index,
                text.as_ptr().cast(),
                text.len() as u64,
                ffi::SQLITE_TRANSIENT(),
                ffi::SQLITE_UTF8 as u8,
            )
        },
        Val::Bytes(bytes) => {
            let data = if bytes.is_empty() {
                c"".as_ptr().cast()
            } else {
                bytes.as_ptr().cast()
            };
            unsafe {
                ffi::sqlite3_bind_blob64(
                    stmt,
                    index,
                    data,
                    bytes.len() as u64,
                    ffi::SQLITE_TRANSIENT(),
                )
            }
        }
        _ => {
            return Err(NativeError::type_error(
                "Binding expected string, TypedArray, boolean, number, bigint or null",
            ));
        }
    };
    if rc != ffi::SQLITE_OK {
        let db = unsafe { ffi::sqlite3_db_handle(stmt) };
        return Err(throw_error(&lossy(unsafe { ffi::sqlite3_errmsg(db) })));
    }
    Ok(())
}

fn bind_all(stmt: *mut ffi::sqlite3_stmt, values: &[Val]) -> Result<()> {
    unsafe { ffi::sqlite3_clear_bindings(stmt) };
    for (i, value) in values.iter().enumerate() {
        bind_value(stmt, i as c_int + 1, value)?;
    }
    Ok(())
}

fn integer(n: i64, safe: bool) -> Val {
    match safe {
        true => Val::BigInt(n),
        false => Val::Num(n as f64),
    }
}

/// Column `i` of the current row.
fn column(stmt: *mut ffi::sqlite3_stmt, i: c_int, safe: bool) -> Val {
    // SAFETY: `stmt` is on a row; column pointers stay valid until the next
    // step/reset, and are copied out at once.
    unsafe {
        match ffi::sqlite3_column_type(stmt, i) {
            ffi::SQLITE_INTEGER => integer(ffi::sqlite3_column_int64(stmt, i), safe),
            ffi::SQLITE_FLOAT => Val::Num(ffi::sqlite3_column_double(stmt, i)),
            ffi::SQLITE_TEXT => {
                let data = ffi::sqlite3_column_text(stmt, i);
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                let bytes = if data.is_null() {
                    &[][..]
                } else {
                    std::slice::from_raw_parts(data, len)
                };
                Val::Str(String::from_utf8_lossy(bytes).into_owned())
            }
            ffi::SQLITE_BLOB => {
                let data = ffi::sqlite3_column_blob(stmt, i).cast::<u8>();
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                Val::Bytes(if data.is_null() {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(data, len).to_vec()
                })
            }
            _ => Val::Null,
        }
    }
}

fn raw_column(stmt: *mut ffi::sqlite3_stmt, i: c_int) -> Val {
    // SAFETY: as in `column`.
    let bytes = unsafe {
        match ffi::sqlite3_column_type(stmt, i) {
            ffi::SQLITE_INTEGER => ffi::sqlite3_column_int64(stmt, i).to_le_bytes().to_vec(),
            ffi::SQLITE_FLOAT => ffi::sqlite3_column_double(stmt, i).to_le_bytes().to_vec(),
            ffi::SQLITE_TEXT | ffi::SQLITE_BLOB => {
                let data = ffi::sqlite3_column_blob(stmt, i).cast::<u8>();
                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                if data.is_null() {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(data, len).to_vec()
                }
            }
            _ => return Val::Null,
        }
    };
    Val::Bytes(bytes)
}

fn column_names(stmt: *mut ffi::sqlite3_stmt) -> Vec<String> {
    // SAFETY: `stmt` is live.
    let count = unsafe { ffi::sqlite3_column_count(stmt) };
    (0..count)
        .map(|i| lossy(unsafe { ffi::sqlite3_column_name(stmt, i) }))
        .collect()
}

/// How rows come back to JS.
#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Object,
    Array,
    /// Arrays of byte buffers.
    Raw,
}

fn row(stmt: *mut ffi::sqlite3_stmt, names: &[String], shape: Shape, safe: bool) -> Val {
    if shape != Shape::Object {
        let values = (0..names.len())
            .map(|i| match shape {
                Shape::Raw => raw_column(stmt, i as c_int),
                _ => column(stmt, i as c_int, safe),
            })
            .collect();
        return Val::Array(values);
    }
    Val::Object(
        names
            .iter()
            .enumerate()
            .map(|(i, name)| (name.clone(), column(stmt, i as c_int, safe)))
            .collect(),
    )
}

fn step(stmt: *mut ffi::sqlite3_stmt) -> Result<bool> {
    // SAFETY: `stmt` is live.
    match unsafe { ffi::sqlite3_step(stmt) } {
        ffi::SQLITE_ROW => Ok(true),
        ffi::SQLITE_DONE => Ok(false),
        _ => {
            let db = unsafe { ffi::sqlite3_db_handle(stmt) };
            let err = sqlite_error(db);
            unsafe { ffi::sqlite3_reset(stmt) };
            Err(err)
        }
    }
}

fn changes(db: *mut ffi::sqlite3, before: i64, safe: bool) -> Val {
    // SAFETY: `db` is open.
    let (after, rowid) = unsafe {
        (
            ffi::sqlite3_total_changes64(db),
            ffi::sqlite3_last_insert_rowid(db),
        )
    };
    Val::Array(vec![
        Val::Num((after - before) as f64),
        integer(rowid, safe),
    ])
}

// --- natives ----------------------------------------------------------------

/// Prepare one statement; null when `sql` holds none (blank or a comment).
fn prepare_raw(db: *mut ffi::sqlite3, sql: &str, flags: u32) -> Result<*mut ffi::sqlite3_stmt> {
    let mut stmt = ptr::null_mut();
    // SAFETY: `db` is open; SQLite reads `sql.len()` bytes.
    let rc = unsafe {
        ffi::sqlite3_prepare_v3(
            db,
            sql.as_ptr().cast(),
            sql.len() as c_int,
            flags,
            &mut stmt,
            ptr::null_mut(),
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db));
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

const SKIPPED: fn(u8) -> bool = |c| c == b' ' || c == b';' || (b'\t'..=b'\r').contains(&c);

/// Prepare the next statement of `bytes` at `offset`. Returns the statement
/// (null for text without one, e.g. a comment) and the bytes consumed, or
/// None when only separators are left.
fn prepare_next(
    db: *mut ffi::sqlite3,
    bytes: &[u8],
    offset: &mut usize,
) -> Result<Option<(Transient, usize)>> {
    while *offset < bytes.len() && SKIPPED(bytes[*offset]) {
        *offset += 1;
    }
    if *offset == bytes.len() {
        return Ok(None);
    }
    let rest = &bytes[*offset..];
    let mut stmt = ptr::null_mut();
    let mut tail: *const c_char = ptr::null();
    // SAFETY: `db` is open; SQLite reads `rest.len()` bytes and points
    // `tail` into them.
    let rc = unsafe {
        ffi::sqlite3_prepare_v3(
            db,
            rest.as_ptr().cast(),
            rest.len() as c_int,
            0,
            &mut stmt,
            &mut tail,
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(sqlite_error(db));
    }
    let consumed = (tail as usize).saturating_sub(rest.as_ptr() as usize);
    Ok(Some((Transient(stmt), consumed)))
}

/// Parameter names of the first statement in `sql` (null when there is no
/// statement); `db.run` computes the values to bind from them.
fn first_param_names(reg: &Shared, id: u32, sql: &str) -> NativeResult {
    let db = reg.borrow().open_db(id)?;
    let bytes = sql.as_bytes();
    let mut offset = 0;
    while let Some((stmt, consumed)) = prepare_next(db, bytes, &mut offset)? {
        if !stmt.0.is_null() {
            return Ok(param_names(stmt.0));
        }
        if consumed == 0 {
            break;
        }
        offset += consumed;
    }
    Ok(Val::Null)
}

/// `db.run(sql, ...)`: every statement in `sql` in turn; `values` are bound
/// to the first statement's parameters.
fn exec(reg: &Shared, id: u32, sql: &str, values: Option<&[Val]>, safe: bool) -> NativeResult {
    let db = reg.borrow().open_db(id)?;
    if sql.is_empty() {
        return Err(throw_error("SQL string mustn't be blank"));
    }
    // SAFETY: `db` is open.
    let before = unsafe { ffi::sqlite3_total_changes64(db) };
    let bytes = sql.as_bytes();
    let mut offset = 0;
    let mut values = values;
    let mut executed = false;
    while let Some((guard, consumed)) = prepare_next(db, bytes, &mut offset)? {
        if guard.0.is_null() {
            // A comment or other text without a statement.
            if consumed == 0 {
                break;
            }
            offset += consumed;
            continue;
        }
        if let Some(values) = values.take() {
            bind_all(guard.0, values)?;
        }
        while step(guard.0)? {}
        executed = true;
        offset += consumed.max(1);
    }
    if !executed {
        return Err(throw_error(
            "Query contained no valid SQL statement; likely empty query.",
        ));
    }
    Ok(changes(db, before, safe))
}

fn param_names(stmt: *mut ffi::sqlite3_stmt) -> Val {
    // SAFETY: `stmt` is live.
    let count = unsafe { ffi::sqlite3_bind_parameter_count(stmt) };
    let names = (1..=count)
        .map(|i| {
            let name = unsafe { ffi::sqlite3_bind_parameter_name(stmt, i) };
            if name.is_null() {
                Val::Null
            } else {
                Val::Str(lossy(name))
            }
        })
        .collect();
    Val::Array(names)
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

/// `native.sqlite.*` (as `sqlite.<name>` entries; the bootstrap nests them).
pub fn install(t: &mut Table) {
    let reg: Shared = Rc::default();
    install_databases(t, &reg);
    install_statements(t, &reg);
}

fn handle(a: &Args<'_>, i: usize) -> Result<u32> {
    a.u32(i)
}

fn install_databases(t: &mut Table, reg: &Shared) {
    let r = reg.clone();
    t.add("sqlite.open", move |a| {
        let path = CString::new(a.str(0)?)
            .map_err(|_| NativeError::type_error("Expected a path without NUL bytes"))?;
        let flags = a.i32(1)?;
        let mut db = ptr::null_mut();
        // SAFETY: valid C strings; `db` receives a connection (even on error).
        let rc =
            unsafe { ffi::sqlite3_open_v2(path.as_ptr(), &mut db, flags, c"unix-none".as_ptr()) };
        if rc != ffi::SQLITE_OK {
            let err = sqlite_error(db);
            unsafe { sqlite3_close_v2(db) };
            return Err(err);
        }
        // SAFETY: `db` is open.
        unsafe {
            ffi::sqlite3_extended_result_codes(db, 1);
            ffi::sqlite3_db_config(
                db,
                ffi::SQLITE_DBCONFIG_DEFENSIVE,
                1,
                ptr::null_mut::<c_int>(),
            );
        }
        Ok(r.borrow_mut().add_db(db).into())
    });
    let r = reg.clone();
    t.add("sqlite.deserialize", move |a| {
        let bytes = a.bytes(0)?;
        if bytes.is_empty() {
            return Err(throw_error("ArrayBuffer must not be empty"));
        }
        let mut db = ptr::null_mut();
        // SAFETY: opens an empty in-memory database, then hands it a copy of
        // the image in SQLite's own allocation (freed on close).
        unsafe {
            if ffi::sqlite3_open_v2(
                c":memory:".as_ptr(),
                &mut db,
                ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE,
                ptr::null(),
            ) != ffi::SQLITE_OK
            {
                sqlite3_close_v2(db);
                return Err(throw_error("Failed to open SQLite"));
            }
            let image = ffi::sqlite3_malloc64(bytes.len() as u64).cast::<u8>();
            if image.is_null() {
                sqlite3_close_v2(db);
                return Err(throw_error("Failed to allocate memory"));
            }
            ptr::copy_nonoverlapping(bytes.as_ptr(), image, bytes.len());
            let mut flags =
                ffi::SQLITE_DESERIALIZE_FREEONCLOSE | ffi::SQLITE_DESERIALIZE_RESIZEABLE;
            if a.bool(1) {
                flags |= ffi::SQLITE_DESERIALIZE_READONLY;
            }
            let len = bytes.len() as i64;
            if ffi::sqlite3_deserialize(db, c"main".as_ptr(), image, len, len, flags)
                != ffi::SQLITE_OK
            {
                let err = sqlite_error(db);
                sqlite3_close_v2(db);
                return Err(err);
            }
            ffi::sqlite3_extended_result_codes(db, 1);
        }
        Ok(r.borrow_mut().add_db(db).into())
    });
    let r = reg.clone();
    t.add("sqlite.serialize", move |a| {
        let db = r.borrow().open_db(handle(&a, 0)?)?;
        let schema = CString::new(a.str(1)?)
            .map_err(|_| NativeError::type_error("Expected a schema name"))?;
        let mut size: i64 = 0;
        // SAFETY: `db` is open; the returned buffer is ours to free.
        let bytes = unsafe {
            let data = ffi::sqlite3_serialize(db, schema.as_ptr(), &mut size, 0);
            if data.is_null() {
                return Err(throw_error("Out of memory"));
            }
            let bytes = std::slice::from_raw_parts(data, size as usize).to_vec();
            ffi::sqlite3_free(data.cast());
            bytes
        };
        Ok(Val::Bytes(bytes))
    });
    let r = reg.clone();
    t.add("sqlite.close", move |a| {
        let id = handle(&a, 0)?;
        let force = a.bool(1);
        let mut reg = r.borrow_mut();
        let Some(db) = reg.dbs.get_mut(&id) else {
            return Err(throw_error("Invalid database handle"));
        };
        if db.ptr.is_null() || (db.closed && !force) {
            return Ok(Val::Undefined);
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
        Ok(Val::Undefined)
    });
    let r = reg.clone();
    t.add("sqlite.inTransaction", move |a| {
        let db = r.borrow().open_db(handle(&a, 0)?)?;
        // SAFETY: `db` is open.
        Ok((unsafe { ffi::sqlite3_get_autocommit(db) } == 0).into())
    });
    let r = reg.clone();
    t.add("sqlite.firstParamNames", move |a| {
        first_param_names(&r, handle(&a, 0)?, a.str(1)?)
    });
    let r = reg.clone();
    t.add("sqlite.exec", move |a| {
        exec(&r, handle(&a, 0)?, a.str(1)?, a.array(2), a.bool(3))
    });
    let r = reg.clone();
    t.add("sqlite.prepare", move |a| {
        let id = handle(&a, 0)?;
        let db = r
            .borrow()
            .open_db(id)
            .map_err(|_| NativeError::range_error("Cannot use a closed database"))?;
        let stmt = prepare_raw(db, a.str(1)?, a.u32(2)?)?;
        if stmt.is_null() {
            return Err(NativeError::range_error("Invalid SQL statement"));
        }
        let mut reg = r.borrow_mut();
        reg.next_id += 1;
        let h = reg.next_id;
        reg.stmts.insert(
            h,
            Stmt {
                ptr: stmt,
                db: id,
                owned: a.bool(3),
                finalized_by_close: false,
                executed: false,
            },
        );
        Ok(h.into())
    });
}

/// Reset `id` and, when given, bind `values`; marks it executed.
fn start(reg: &Shared, id: u32, values: Option<&[Val]>) -> Result<*mut ffi::sqlite3_stmt> {
    let stmt = reg.borrow().live_stmt(id)?;
    // SAFETY: `stmt` is live.
    unsafe { ffi::sqlite3_reset(stmt) };
    if let Some(values) = values {
        bind_all(stmt, values)?;
    }
    if let Some(s) = reg.borrow_mut().stmts.get_mut(&id) {
        s.executed = true;
    }
    Ok(stmt)
}

fn install_statements(t: &mut Table, reg: &Shared) {
    let r = reg.clone();
    // get() / all() / values() / raw(): mode 0 = first row object (or null),
    // 1 = row objects, 2 = row arrays, 3 = row arrays of bytes (2 and 3 give
    // null for statements without columns).
    t.add("sqlite.rows", move |a| {
        let stmt = start(&r, handle(&a, 0)?, a.array(1))?;
        let (mode, safe) = (a.u32(2)?, a.bool(3));
        let names = column_names(stmt);
        if mode == 0 {
            let found = step(stmt)?;
            let result = match found && !names.is_empty() {
                true => row(stmt, &names, Shape::Object, safe),
                false => Val::Null,
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
        let mut out = Vec::new();
        while step(stmt)? {
            if !names.is_empty() {
                out.push(row(stmt, &names, shape, safe));
            }
        }
        unsafe { ffi::sqlite3_reset(stmt) };
        if names.is_empty() && shape != Shape::Object {
            return Ok(Val::Null);
        }
        Ok(Val::Array(out))
    });
    let r = reg.clone();
    // iterate(): the next row object, or null at the end. `first` starts over.
    t.add("sqlite.next", move |a| {
        let id = handle(&a, 0)?;
        let stmt = match a.bool(2) {
            true => start(&r, id, a.array(1))?,
            false => r.borrow().live_stmt(id)?,
        };
        if !step(stmt)? {
            unsafe { ffi::sqlite3_reset(stmt) };
            return Ok(Val::Null);
        }
        Ok(row(stmt, &column_names(stmt), Shape::Object, a.bool(3)))
    });
    let r = reg.clone();
    t.add("sqlite.run", move |a| {
        let stmt = start(&r, handle(&a, 0)?, a.array(1))?;
        // SAFETY: a live statement belongs to an open connection.
        let db = unsafe { ffi::sqlite3_db_handle(stmt) };
        let before = unsafe { ffi::sqlite3_total_changes64(db) };
        while step(stmt)? {}
        unsafe { ffi::sqlite3_reset(stmt) };
        Ok(changes(db, before, a.bool(2)))
    });
    let r = reg.clone();
    t.add("sqlite.bind", move |a| {
        start(&r, handle(&a, 0)?, Some(a.array(1).unwrap_or(&[])))?;
        Ok(Val::Undefined)
    });
    let r = reg.clone();
    t.add("sqlite.paramNames", move |a| {
        Ok(param_names(r.borrow().live_stmt(handle(&a, 0)?)?))
    });
    let r = reg.clone();
    t.add("sqlite.columns", move |a| {
        let stmt = r.borrow().live_stmt(handle(&a, 0)?)?;
        Ok(Val::Array(
            column_names(stmt).into_iter().map(Val::Str).collect(),
        ))
    });
    let r = reg.clone();
    t.add("sqlite.columnTypes", move |a| {
        let stmt = r.borrow().live_stmt(handle(&a, 0)?)?;
        // SAFETY: `stmt` is live.
        if unsafe { ffi::sqlite3_stmt_readonly(stmt) } == 0 {
            return Err(throw_error(
                "columnTypes is not available for non-read-only statements (INSERT, UPDATE, DELETE, etc.)",
            ));
        }
        // Types of the first row: safe to step a read-only statement.
        let count = unsafe { ffi::sqlite3_column_count(stmt) };
        unsafe { ffi::sqlite3_reset(stmt) };
        let found = step(stmt)?;
        let types = (0..count)
            .map(|i| Val::from(if found { type_name(unsafe { ffi::sqlite3_column_type(stmt, i) }) } else { "NULL" }))
            .collect();
        unsafe { ffi::sqlite3_reset(stmt) };
        Ok(Val::Array(types))
    });
    let r = reg.clone();
    t.add("sqlite.declaredTypes", move |a| {
        let id = handle(&a, 0)?;
        let stmt = r.borrow().live_stmt(id)?;
        if !r.borrow().stmts.get(&id).is_some_and(|s| s.executed) {
            return Err(throw_error(
                "Statement must be executed before accessing declaredTypes",
            ));
        }
        // SAFETY: `stmt` is live.
        let count = unsafe { ffi::sqlite3_column_count(stmt) };
        let types = (0..count)
            .map(|i| {
                let decl = unsafe { ffi::sqlite3_column_decltype(stmt, i) };
                if decl.is_null() {
                    Val::Null
                } else {
                    Val::Str(lossy(decl))
                }
            })
            .collect();
        Ok(Val::Array(types))
    });
    let r = reg.clone();
    t.add("sqlite.paramsCount", move |a| {
        let stmt = r.borrow().live_stmt(handle(&a, 0)?)?;
        // SAFETY: `stmt` is live.
        Ok(unsafe { ffi::sqlite3_bind_parameter_count(stmt) }.into())
    });
    let r = reg.clone();
    t.add("sqlite.expandedSql", move |a| {
        let stmt = r.borrow().live_stmt(handle(&a, 0)?)?;
        // SAFETY: `stmt` is live; the expanded text is ours to free.
        unsafe {
            let text = ffi::sqlite3_expanded_sql(stmt);
            let sql = lossy(text);
            ffi::sqlite3_free(text.cast());
            Ok(sql.into())
        }
    });
    let r = reg.clone();
    t.add("sqlite.isFinalized", move |a| {
        let id = handle(&a, 0)?;
        Ok(r.borrow()
            .stmts
            .get(&id)
            .is_none_or(|s| s.ptr.is_null())
            .into())
    });
    let r = reg.clone();
    t.add("sqlite.finalize", move |a| {
        r.borrow_mut().finalize(handle(&a, 0)?, false);
        Ok(Val::Undefined)
    });
    let r = reg.clone();
    // FinalizationRegistry callback for statements that were never finalized.
    t.add("sqlite.release", move |a| {
        let id = handle(&a, 0)?;
        let mut reg = r.borrow_mut();
        reg.finalize(id, false);
        reg.stmts.remove(&id);
        Ok(Val::Undefined)
    });
}
