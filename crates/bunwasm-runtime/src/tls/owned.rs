use std::cell::Cell;
use std::ffi::c_int;
use std::ptr::NonNull;
use std::rc::Rc;

use super::{Failure, Result};
use bunwasm_crypto_sys::tls as ffi;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub contexts: u64,
    pub sessions: u64,
    pub bios: u64,
    pub stores: u64,
    pub certificates: u64,
    pub keys: u64,
    pub root_sets: u64,
}

#[derive(Default)]
pub struct Meter {
    pub live: Cell<Counts>,
    pub freed: Cell<Counts>,
}

#[derive(Clone, Copy)]
pub enum Kind {
    Context,
    Session,
    Bio,
    Store,
    Certificate,
    Key,
    RootSet,
}

impl Kind {
    fn field(self, counts: &mut Counts) -> &mut u64 {
        match self {
            Self::Context => &mut counts.contexts,
            Self::Session => &mut counts.sessions,
            Self::Bio => &mut counts.bios,
            Self::Store => &mut counts.stores,
            Self::Certificate => &mut counts.certificates,
            Self::Key => &mut counts.keys,
            Self::RootSet => &mut counts.root_sets,
        }
    }
}

impl Meter {
    fn allocated(&self, kind: Kind) {
        let mut counts = self.live.get();
        *kind.field(&mut counts) += 1;
        self.live.set(counts);
    }

    pub fn released(&self, kind: Kind) {
        let mut live = self.live.get();
        let mut freed = self.freed.get();
        *kind.field(&mut live) -= 1;
        *kind.field(&mut freed) += 1;
        self.live.set(live);
        self.freed.set(freed);
    }
}

pub struct Owned<T> {
    pointer: Option<NonNull<T>>,
    free: unsafe extern "C" fn(*mut T),
    meter: Rc<Meter>,
    kind: Kind,
}

impl<T> Owned<T> {
    pub fn new(
        pointer: *mut T,
        free: unsafe extern "C" fn(*mut T),
        kind: Kind,
        meter: &Rc<Meter>,
    ) -> Result<Self> {
        let pointer = NonNull::new(pointer)
            .ok_or_else(|| Failure::new("ERR_TLS_ALLOCATION", "TLS allocation failed"))?;
        meter.allocated(kind);
        Ok(Self {
            pointer: Some(pointer),
            free,
            kind,
            meter: meter.clone(),
        })
    }

    pub fn pointer(&self) -> *mut T {
        self.pointer
            .expect("owned TLS pointer transferred only at construction")
            .as_ptr()
    }

    pub fn transfer(&mut self) -> *mut T {
        self.pointer
            .take()
            .expect("TLS pointer transferred once")
            .as_ptr()
    }
}

impl<T> Drop for Owned<T> {
    fn drop(&mut self) {
        let Some(pointer) = self.pointer else {
            return;
        };
        unsafe {
            (self.free)(pointer.as_ptr());
        }
        self.meter.released(self.kind);
    }
}

// BIO_free has a return value; the generic owner uses a void-returning destructor.
unsafe extern "C" fn free_bio(pointer: *mut ffi::Bio) {
    unsafe {
        ffi::BIO_free(pointer);
    }
}

pub fn bio(pointer: *mut ffi::Bio, meter: &Rc<Meter>) -> Result<Owned<ffi::Bio>> {
    Owned::new(pointer, free_bio, Kind::Bio, meter)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ErrorStack {
    pub(super) codes: [u32; 4],
    pub(super) len: usize,
}

pub fn clear() {
    unsafe {
        ffi::ERR_clear_error();
    }
}

pub fn capture() -> ErrorStack {
    let mut errors = ErrorStack::default();
    loop {
        let code = unsafe { ffi::ERR_get_error() };
        if code == 0 {
            return errors;
        }
        if errors.len < errors.codes.len() {
            errors.codes[errors.len] = code;
            errors.len += 1;
        }
    }
}

pub fn checked(
    call: impl FnOnce() -> c_int,
    code: &'static str,
    message: &'static str,
) -> Result<()> {
    clear();
    let result = call();
    let errors = capture();
    if result != 1 {
        return Err(Failure::with_errors(code, message, errors));
    }
    Ok(())
}

pub fn allocated<T>(
    call: impl FnOnce() -> *mut T,
    free: unsafe extern "C" fn(*mut T),
    kind: Kind,
    meter: &Rc<Meter>,
) -> Result<Owned<T>> {
    clear();
    let pointer = call();
    let errors = capture();
    Owned::new(pointer, free, kind, meter).map_err(|failure| failure.errors(errors))
}

pub struct Session {
    pub ssl: Owned<ffi::Ssl>,
    pub network: Owned<ffi::Bio>,
    pub inside: *mut ffi::Bio,
    meter: Rc<Meter>,
}

impl Session {
    pub fn new(context: *mut ffi::SslCtx, meter: &Rc<Meter>) -> Result<Self> {
        Self::with_capacity(context, meter, super::BIO_CAPACITY)
    }

    pub(super) fn with_capacity(
        context: *mut ffi::SslCtx,
        meter: &Rc<Meter>,
        capacity: usize,
    ) -> Result<Self> {
        let ssl = allocated(
            || unsafe { ffi::SSL_new(context) },
            ffi::SSL_free,
            Kind::Session,
            meter,
        )?;
        let (mut inside, network) = pair(meter, capacity)?;
        clear();
        unsafe {
            ffi::SSL_set_bio(ssl.pointer(), inside.pointer(), inside.pointer());
        }
        capture();
        let inside = inside.transfer();
        Ok(Self {
            ssl,
            network,
            inside,
            meter: meter.clone(),
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SSL_free, run by the first field's destructor, frees the transferred BIO.
        self.meter.released(Kind::Bio);
    }
}

pub fn pair(meter: &Rc<Meter>, capacity: usize) -> Result<(Owned<ffi::Bio>, Owned<ffi::Bio>)> {
    let mut inside = std::ptr::null_mut();
    let mut network = std::ptr::null_mut();
    clear();
    let result = unsafe { ffi::BIO_new_bio_pair(&mut inside, capacity, &mut network, capacity) };
    let errors = capture();
    if result != 1 {
        unsafe {
            ffi::BIO_free(inside);
            ffi::BIO_free(network);
        }
        return Err(Failure::with_errors(
            "ERR_TLS_ALLOCATION",
            "TLS BIO allocation failed",
            errors,
        ));
    }
    Ok((bio(inside, meter)?, bio(network, meter)?))
}
