//! Process-owned, engine-independent TLS over caller-owned ciphertext transport.
//! This module never owns a socket, invokes JavaScript, or reads host files.

use std::cell::RefCell;
use std::rc::Rc;

#[path = "tls/bindings.rs"]
mod bindings;
#[path = "tls/context.rs"]
mod context;
#[path = "tls/driver.rs"]
mod driver;
#[path = "tls/owned.rs"]
mod owned;
#[path = "tls/slots.rs"]
mod slots;
#[path = "tls/trust.rs"]
mod trust;

pub use context::{CaMode, ContextOptions};
pub use driver::{Allowance, ConnectionOptions, Event, Outcome, PeerInfo, Step, VerifyMode, Wait};
pub use owned::{Counts, ErrorStack};
pub use slots::{ConnectionId, ContextId, Release};
pub use trust::{StartupExtras, snapshot_startup_extras};

pub const BIO_CAPACITY: usize = 64 * 1024;
pub const MAX_BATCH: usize = 64 * 1024;
pub const MAX_PLAINTEXT: usize = 16 * 1024;
pub const MAX_CERT_LIST: usize = 256 * 1024;

pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub message: &'static str,
    pub diagnostics: ErrorStack,
}

impl Failure {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            diagnostics: ErrorStack::default(),
        }
    }
    fn with_errors(code: &'static str, message: &'static str, diagnostics: ErrorStack) -> Self {
        Self {
            code,
            message,
            diagnostics,
        }
    }
    fn errors(mut self, diagnostics: ErrorStack) -> Self {
        self.diagnostics = diagnostics;
        self
    }
    fn invalid_id() -> Self {
        Self::new("ERR_TLS_INVALID_ID", "Invalid or stale TLS object ID")
    }
}

pub struct ResourceCounts {
    pub contexts: usize,
    pub connections: usize,
    pub owned: Counts,
    pub freed: Counts,
}

pub type SharedRegistry = Rc<RefCell<TlsRegistry>>;

pub struct TlsRegistry {
    contexts: slots::Slots<Rc<context::Context>, ContextId>,
    connections: slots::Slots<driver::Connection, ConnectionId>,
    trust: trust::Trust,
    meter: Rc<owned::Meter>,
    disposed: bool,
}

impl TlsRegistry {
    pub fn new(startup: StartupExtras) -> Self {
        let meter = Rc::new(owned::Meter::default());
        Self {
            contexts: slots::Slots::new(1024),
            connections: slots::Slots::new(4096),
            trust: trust::Trust::new(startup, &meter),
            meter,
            disposed: false,
        }
    }

    pub fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        self.disposed = true;
        self.connections.clear();
        self.contexts.clear();
        self.trust.dispose();
    }

    fn ensure_open(&self) -> Result<()> {
        if self.disposed {
            return Err(Failure::new(
                "ERR_TLS_REGISTRY_DISPOSED",
                "TLS registry has been disposed",
            ));
        }
        Ok(())
    }

    pub fn create_context(&mut self, options: ContextOptions<'_>) -> Result<ContextId> {
        self.ensure_open()?;
        let context = context::Context::new(options, &mut self.trust, &self.meter)?;
        self.contexts.insert(Rc::new(context))
    }

    pub fn create_connection(
        &mut self,
        id: ContextId,
        options: ConnectionOptions<'_>,
    ) -> Result<ConnectionId> {
        self.ensure_open()?;
        let context = self.contexts.get(id)?.clone();
        self.connections
            .insert(driver::Connection::new(context, options, &self.meter)?)
    }

    pub fn step(
        &mut self,
        id: ConnectionId,
        event: Event<'_>,
        allowance: Allowance,
    ) -> Result<Step> {
        self.ensure_open()?;
        self.connections.get_mut(id)?.step(event, allowance)
    }

    pub fn accept_identity(
        &mut self,
        id: ConnectionId,
        accepted: bool,
        code: Option<&str>,
    ) -> Result<()> {
        self.ensure_open()?;
        self.connections
            .get_mut(id)?
            .accept_identity(accepted, code)
    }

    pub fn inspect(&self, id: ConnectionId) -> Result<PeerInfo> {
        self.ensure_open()?;
        self.connections.get(id)?.inspect()
    }
    pub fn authorized(&self, id: ConnectionId) -> Result<bool> {
        self.ensure_open()?;
        Ok(self.connections.get(id)?.authorized())
    }
    pub fn authorization_error(&self, id: ConnectionId) -> Result<Option<&'static str>> {
        self.ensure_open()?;
        Ok(self.connections.get(id)?.authorization_error())
    }
    pub fn release_context(&mut self, id: ContextId) -> Result<Release> {
        self.contexts.release(id)
    }
    pub fn release_connection(&mut self, id: ConnectionId) -> Result<Release> {
        self.connections.release(id)
    }
    pub fn take_warning(&mut self) -> Option<&'static str> {
        self.trust.take_warning()
    }

    pub fn counts(&self) -> ResourceCounts {
        ResourceCounts {
            contexts: self.contexts.len(),
            connections: self.connections.len(),
            owned: self.meter.live.get(),
            freed: self.meter.freed.get(),
        }
    }
}

/// Install the existing typed operations against the process-owned registry.
pub(crate) fn install(table: &mut crate::natives::Table, registry: SharedRegistry) {
    bindings::install(table, registry);
}

pub(crate) fn new_shared_registry(startup: StartupExtras) -> SharedRegistry {
    Rc::new(RefCell::new(TlsRegistry::new(startup)))
}

#[cfg(all(test, not(target_os = "wasi")))]
#[path = "tls/tests.rs"]
mod tests;
