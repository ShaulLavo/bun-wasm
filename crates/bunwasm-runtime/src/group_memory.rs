//! A shared-group member's view of its memory group (docs/shared-group-profile.md).
//!
//! SharedArrayBuffer backings are group regions: every member addresses the same bytes at
//! the same address. The group (Waffle or bunwasm-host `runtime_shm`) counts holds per
//! member; this table counts the engine's aliases inside one member and keeps exactly one
//! group hold per region while any alias lives. Transfers pin a region, route the pin to
//! the destination process and let the destination accept it. The engine side imports
//! these functions as `bun_shm_*` / `bun_futex_*`; JSC and Hermes are not qualified yet.

use std::collections::HashMap;

/// The `runtime_shm` imports this table needs; native unit tests substitute a fake group.
pub(crate) trait Group {
    fn create(&mut self, len: u32) -> Result<(u32, u32), i32>;
    fn detach(&mut self, handle: u32) -> i32;
    fn pin(&mut self, handle: u32) -> Result<u32, i32>;
    fn accept(&mut self, pin: u32) -> Result<(u32, u32, u32), i32>;
}

const EBADF: i32 = -8;

struct Alias {
    handle: u32,
    refs: u32,
}

/// Engine aliases per region address. One group hold backs every alias of a region.
#[derive(Default)]
pub(crate) struct Aliases(HashMap<u32, Alias>);

impl Aliases {
    /// A zeroed region for a new SharedArrayBuffer, held by its first alias.
    pub(crate) fn create(&mut self, group: &mut impl Group, len: u32) -> Result<u32, i32> {
        let (handle, addr) = group.create(len)?;
        self.0.insert(addr, Alias { handle, refs: 1 });
        Ok(addr)
    }

    pub(crate) fn retain(&mut self, addr: u32) -> Result<(), i32> {
        let alias = self.0.get_mut(&addr).ok_or(EBADF)?;
        alias.refs += 1;
        Ok(())
    }

    /// Drop one alias; the last one gives the member's hold back to the group.
    pub(crate) fn release(&mut self, group: &mut impl Group, addr: u32) -> Result<(), i32> {
        let alias = self.0.get_mut(&addr).ok_or(EBADF)?;
        alias.refs -= 1;
        if alias.refs != 0 {
            return Ok(());
        }
        let handle = alias.handle;
        self.0.remove(&addr);
        match group.detach(handle) {
            0 => Ok(()),
            error => Err(error),
        }
    }

    /// Pin a held region for one message; only aliased regions can be published.
    pub(crate) fn pin(&self, group: &mut impl Group, addr: u32) -> Result<u32, i32> {
        let alias = self.0.get(&addr).ok_or(EBADF)?;
        group.pin(alias.handle)
    }

    /// Accept a pin routed to this member. The result carries one transit alias, which the
    /// caller releases once the engine object (which retains its own) exists or failed.
    pub(crate) fn accept(&mut self, group: &mut impl Group, pin: u32) -> Result<(u32, u32), i32> {
        let (handle, addr, len) = group.accept(pin)?;
        match self.0.get_mut(&addr) {
            Some(alias) => {
                alias.refs += 1;
                // Already held through another alias: keep one hold per member and region.
                match group.detach(handle) {
                    0 => Ok((addr, len)),
                    error => Err(error),
                }
            }
            None => {
                self.0.insert(addr, Alias { handle, refs: 1 });
                Ok((addr, len))
            }
        }
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
mod exports {
    use std::cell::RefCell;

    use super::*;

    #[link(wasm_import_module = "runtime_shm")]
    unsafe extern "C" {
        fn shm_create(len: u32, align: u32, out: *mut [u32; 2]) -> i32;
        fn shm_detach(handle: u32) -> i32;
        fn shm_pin(handle: u32, out: *mut u32) -> i32;
        fn shm_route(pin: u32, pid: u32) -> i32;
        fn shm_accept(pin: u32, out: *mut [u32; 3]) -> i32;
        fn shm_unpin(pin: u32) -> i32;
        fn futex_wait32(addr: u32, expected: i32, timeout_ns: i64) -> i32;
        fn futex_wait64(addr: u32, expected: i64, timeout_ns: i64) -> i32;
        fn futex_wake(addr: u32, count: u32) -> i32;
        fn futex_watch(addr: u32, expected: i32, out: *mut u32) -> i32;
        fn futex_unwatch(id: u32) -> i32;
    }

    /// Typed arrays over a backing need at most 8-byte alignment; regions are page-aligned.
    const ALIGN: u32 = 8;

    struct RuntimeShm;

    impl Group for RuntimeShm {
        fn create(&mut self, len: u32) -> Result<(u32, u32), i32> {
            let mut out = [0; 2];
            match unsafe { shm_create(len, ALIGN, &mut out) } {
                0 => Ok((out[0], out[1])),
                error => Err(error),
            }
        }
        fn detach(&mut self, handle: u32) -> i32 {
            unsafe { shm_detach(handle) }
        }
        fn pin(&mut self, handle: u32) -> Result<u32, i32> {
            let mut out = 0;
            match unsafe { shm_pin(handle, &mut out) } {
                0 => Ok(out),
                error => Err(error),
            }
        }
        fn accept(&mut self, pin: u32) -> Result<(u32, u32, u32), i32> {
            let mut out = [0; 3];
            match unsafe { shm_accept(pin, &mut out) } {
                0 => Ok((out[0], out[1], out[2])),
                error => Err(error),
            }
        }
    }

    thread_local! {
        static ALIASES: RefCell<Aliases> = RefCell::new(Aliases::default());
    }

    fn status(result: Result<(), i32>) -> i32 {
        result.map_or_else(|error| error, |()| 0)
    }

    /// The new region's address, or 0 when the group refuses it.
    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_create(len: u32) -> u32 {
        ALIASES.with(|aliases| {
            aliases
                .borrow_mut()
                .create(&mut RuntimeShm, len)
                .unwrap_or(0)
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_retain(addr: u32) -> i32 {
        ALIASES.with(|aliases| status(aliases.borrow_mut().retain(addr)))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_release(addr: u32) -> i32 {
        ALIASES.with(|aliases| status(aliases.borrow_mut().release(&mut RuntimeShm, addr)))
    }

    /// Writes the pin to `out`.
    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_pin(addr: u32, out: *mut u32) -> i32 {
        match ALIASES.with(|aliases| aliases.borrow().pin(&mut RuntimeShm, addr)) {
            Ok(pin) => {
                unsafe { out.write(pin) };
                0
            }
            Err(error) => error,
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_route(pin: u32, pid: u32) -> i32 {
        unsafe { shm_route(pin, pid) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_unpin(pin: u32) -> i32 {
        unsafe { shm_unpin(pin) }
    }

    /// Writes `[addr, len]` to `out`; the caller owns one transit alias of `addr`.
    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shm_accept(pin: u32, out: *mut [u32; 2]) -> i32 {
        match ALIASES.with(|aliases| aliases.borrow_mut().accept(&mut RuntimeShm, pin)) {
            Ok((addr, len)) => {
                unsafe { out.write([addr, len]) };
                0
            }
            Err(error) => error,
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_futex_wait32(addr: u32, expected: i32, timeout_ns: i64) -> i32 {
        unsafe { futex_wait32(addr, expected, timeout_ns) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_futex_wait64(addr: u32, expected: i64, timeout_ns: i64) -> i32 {
        unsafe { futex_wait64(addr, expected, timeout_ns) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_futex_wake(addr: u32, count: u32) -> i32 {
        unsafe { futex_wake(addr, count) }
    }

    /// A FUTEX watch for poll kind 7 (shared lanes); writes its id to `out`.
    #[unsafe(no_mangle)]
    pub extern "C" fn bun_futex_watch(addr: u32, expected: i32, out: *mut u32) -> i32 {
        unsafe { futex_watch(addr, expected, out) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_futex_unwatch(id: u32) -> i32 {
        unsafe { futex_unwatch(id) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One member's side of a group: holds per handle, pins it owns, and regions by address.
    #[derive(Default)]
    struct Fake {
        next: u32,
        holds: HashMap<u32, u32>,
        regions: HashMap<u32, (u32, u32)>,
        pins: HashMap<u32, u32>,
    }

    impl Group for Fake {
        fn create(&mut self, len: u32) -> Result<(u32, u32), i32> {
            self.next += 1;
            let (handle, addr) = (self.next, self.next * 65536);
            self.regions.insert(handle, (addr, len));
            *self.holds.entry(handle).or_default() += 1;
            Ok((handle, addr))
        }
        fn detach(&mut self, handle: u32) -> i32 {
            let Some(count) = self.holds.get_mut(&handle) else {
                return EBADF;
            };
            *count -= 1;
            if *count == 0 {
                self.holds.remove(&handle);
            }
            0
        }
        fn pin(&mut self, handle: u32) -> Result<u32, i32> {
            if !self.holds.contains_key(&handle) {
                return Err(EBADF);
            }
            self.next += 1;
            self.pins.insert(self.next, handle);
            Ok(self.next)
        }
        fn accept(&mut self, pin: u32) -> Result<(u32, u32, u32), i32> {
            let handle = self.pins.remove(&pin).ok_or(EBADF)?;
            *self.holds.entry(handle).or_default() += 1;
            let (addr, len) = self.regions[&handle];
            Ok((handle, addr, len))
        }
    }

    #[test]
    fn last_alias_returns_the_single_hold() {
        let (mut group, mut aliases) = (Fake::default(), Aliases::default());
        let addr = aliases.create(&mut group, 16).unwrap();
        aliases.retain(addr).unwrap();
        aliases.release(&mut group, addr).unwrap();
        assert_eq!(group.holds.len(), 1, "one alias still live");
        aliases.release(&mut group, addr).unwrap();
        assert!(group.holds.is_empty());
        assert_eq!(
            aliases.release(&mut group, addr),
            Err(EBADF),
            "no double release"
        );
    }

    #[test]
    fn accepting_an_already_held_region_keeps_one_hold() {
        let (mut group, mut aliases) = (Fake::default(), Aliases::default());
        let addr = aliases.create(&mut group, 16).unwrap();
        let pin = aliases.pin(&mut group, addr).unwrap();
        assert_eq!(aliases.accept(&mut group, pin).unwrap(), (addr, 16));
        assert_eq!(group.holds.values().copied().collect::<Vec<_>>(), [1]);
        aliases.release(&mut group, addr).unwrap(); // transit alias
        aliases.release(&mut group, addr).unwrap(); // creator
        assert!(group.holds.is_empty());
    }

    #[test]
    fn a_received_region_is_held_until_its_last_alias() {
        let (mut sender, mut receiver) = (Fake::default(), Aliases::default());
        let mut source = Aliases::default();
        let addr = source.create(&mut sender, 8).unwrap();
        let pin = source.pin(&mut sender, addr).unwrap();
        source.release(&mut sender, addr).unwrap();
        // The pin, not the sender's alias, keeps the region for the receiver.
        assert!(sender.holds.is_empty());
        let (received, len) = receiver.accept(&mut sender, pin).unwrap();
        assert_eq!((received, len), (addr, 8));
        receiver.retain(received).unwrap(); // the engine object
        receiver.release(&mut sender, received).unwrap(); // transit alias
        assert_eq!(sender.holds.len(), 1);
        receiver.release(&mut sender, received).unwrap();
        assert!(sender.holds.is_empty());
    }

    #[test]
    fn only_aliased_regions_can_be_pinned() {
        let (mut group, aliases) = (Fake::default(), Aliases::default());
        assert_eq!(aliases.pin(&mut group, 65536), Err(EBADF));
        assert!(group.pins.is_empty());
    }
}
