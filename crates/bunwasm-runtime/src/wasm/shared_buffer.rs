//! Storage for one group member's ordinary SharedArrayBuffers. Each buffer is its own nested
//! memory region, so another member can lease the same bytes after this one stops.
//!
//! Engines finalize buffers during GC. A finalizer only queues the region here; the next
//! allocation hands it back to the host. Member stop releases whatever is still queued.
use std::{cell::RefCell, collections::BTreeMap};

const PAGE_BYTES: u32 = 65_536;

trait Regions {
    fn reserve(&self, pages: u32) -> Option<u32>;
    fn address(&self, memory: u32) -> Option<u32>;
    fn release(&self, memory: u32);
}

#[derive(Default)]
struct Ledger {
    buffers: BTreeMap<u32, u32>,
    released: Vec<u32>,
}

fn pages(bytes: u32) -> u32 {
    bytes.max(1).div_ceil(PAGE_BYTES)
}

/// No ledger borrow survives a host request.
fn allocate(ledger: &RefCell<Ledger>, regions: &impl Regions, bytes: u32) -> u32 {
    let released = std::mem::take(&mut ledger.borrow_mut().released);
    for memory in released {
        regions.release(memory);
    }
    let Some(memory) = regions.reserve(pages(bytes)) else {
        return 0;
    };
    let Some(address) = regions.address(memory) else {
        regions.release(memory);
        return 0;
    };
    ledger.borrow_mut().buffers.insert(address, memory);
    address
}

fn release(ledger: &RefCell<Ledger>, address: u32) {
    let mut ledger = ledger.borrow_mut();
    if let Some(memory) = ledger.buffers.remove(&address) {
        ledger.released.push(memory);
    }
}

fn resource(ledger: &RefCell<Ledger>, address: u32) -> u32 {
    ledger.borrow().buffers.get(&address).copied().unwrap_or(0)
}

#[cfg(bun_wasm_shared_group)]
mod host {
    use super::super::{nested, resource_id};
    use super::{Ledger, RefCell, Regions, allocate, release, resource};
    use crate::data::Val;

    thread_local! {
        static LEDGER: RefCell<Ledger> = RefCell::default();
    }

    struct Host;

    impl Regions for Host {
        fn reserve(&self, pages: u32) -> Option<u32> {
            resource_id(&nested::create_memory(pages, pages).ok()?).ok()
        }

        fn address(&self, memory: u32) -> Option<u32> {
            let Val::Object(fields) = nested::span(memory).ok()? else {
                return None;
            };
            let (_, pointer) = fields.iter().find(|(name, _)| name == "pointer")?;
            resource_id(pointer).ok()
        }

        fn release(&self, memory: u32) {
            let _ = nested::release_memory(memory);
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shared_buffer_alloc(bytes: u32) -> u32 {
        LEDGER.with(|ledger| allocate(ledger, &Host, bytes))
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shared_buffer_release(address: u32) {
        LEDGER.with(|ledger| release(ledger, address));
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn bun_shared_buffer_resource(address: u32) -> u32 {
        LEDGER.with(|ledger| resource(ledger, address))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    struct Fake {
        next: Cell<u32>,
        refuse_reserve: Cell<bool>,
        refuse_address: Cell<bool>,
        released: RefCell<Vec<u32>>,
    }

    impl Regions for Fake {
        fn reserve(&self, _pages: u32) -> Option<u32> {
            if self.refuse_reserve.get() {
                return None;
            }
            self.next.set(self.next.get() + 1);
            Some(self.next.get())
        }

        fn address(&self, memory: u32) -> Option<u32> {
            (!self.refuse_address.get()).then_some(memory * PAGE_BYTES)
        }

        fn release(&self, memory: u32) {
            self.released.borrow_mut().push(memory);
        }
    }

    #[test]
    fn page_rounding_keeps_a_real_page_for_an_empty_buffer() {
        assert_eq!(pages(0), 1);
        assert_eq!(pages(1), 1);
        assert_eq!(pages(PAGE_BYTES), 1);
        assert_eq!(pages(PAGE_BYTES + 1), 2);
        assert_eq!(pages(u32::MAX), 65_536);
    }

    #[test]
    fn a_finalized_buffer_is_only_queued_until_the_next_allocation() {
        let ledger = RefCell::default();
        let fake = Fake::default();
        let first = allocate(&ledger, &fake, 8);
        assert_eq!(resource(&ledger, first), 1);
        release(&ledger, first);
        assert!(
            fake.released.borrow().is_empty(),
            "a finalizer reaches the host"
        );
        assert_eq!(resource(&ledger, first), 0);
        let second = allocate(&ledger, &fake, 8);
        assert_eq!(*fake.released.borrow(), [1]);
        assert_eq!(resource(&ledger, second), 2);
    }

    #[test]
    fn unknown_and_repeated_finalizers_change_nothing() {
        let ledger = RefCell::default();
        let fake = Fake::default();
        let address = allocate(&ledger, &fake, 8);
        release(&ledger, address + PAGE_BYTES);
        release(&ledger, address);
        release(&ledger, address);
        assert_eq!(ledger.borrow().released, [1]);
    }

    #[test]
    fn a_failed_address_returns_the_region_and_reports_failure() {
        let ledger = RefCell::default();
        let fake = Fake::default();
        fake.refuse_address.set(true);
        assert_eq!(allocate(&ledger, &fake, 8), 0);
        assert_eq!(*fake.released.borrow(), [1]);
        assert!(ledger.borrow().buffers.is_empty());
    }

    #[test]
    fn a_refused_reservation_still_drains_the_queue_for_the_retry() {
        let ledger = RefCell::default();
        let fake = Fake::default();
        let address = allocate(&ledger, &fake, 8);
        release(&ledger, address);
        fake.refuse_reserve.set(true);
        assert_eq!(allocate(&ledger, &fake, 8), 0);
        assert_eq!(*fake.released.borrow(), [1]);
        fake.refuse_reserve.set(false);
        assert_ne!(allocate(&ledger, &fake, 8), 0);
    }

    #[test]
    fn a_finalizer_may_run_while_a_release_is_in_flight() {
        struct Reentrant<'a> {
            fake: Fake,
            ledger: &'a RefCell<Ledger>,
            address: u32,
        }
        impl Regions for Reentrant<'_> {
            fn reserve(&self, pages: u32) -> Option<u32> {
                self.fake.reserve(pages)
            }
            fn address(&self, memory: u32) -> Option<u32> {
                self.fake.address(memory)
            }
            fn release(&self, memory: u32) {
                release(self.ledger, self.address);
                self.fake.release(memory);
            }
        }
        let ledger = RefCell::default();
        let fake = Fake::default();
        let first = allocate(&ledger, &fake, 8);
        let second = allocate(&ledger, &fake, 8);
        release(&ledger, first);
        let reentrant = Reentrant {
            fake,
            ledger: &ledger,
            address: second,
        };
        allocate(&ledger, &reentrant, 8);
        assert_eq!(*reentrant.fake.released.borrow(), [1]);
        assert_eq!(ledger.borrow().released, [2]);
    }
}
