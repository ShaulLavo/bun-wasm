//! Guest memory as host imports see it (docs/shared-group-profile.md).
//!
//! A private memory belongs to one store, so an import borrows exactly the ranges it uses, with
//! no copy. A memory-group member's shared memory is written concurrently by other agents. It
//! is touched only through atomic cells and owned copies of the bytes a call reads or produces,
//! never through a Rust slice. Ranges are bounds-checked here; callers keep their own error
//! conventions for a `None`.
//!
//! A shared memory is held as the memory group's `SharedMemoryLease`, never as a bare
//! `SharedMemory`: the lease keeps the group's backing charged while any host value can reach
//! it. The raw memory is borrowed only for one call, and leaves only through the unsafe
//! admission export.

use std::cell::UnsafeCell;
use std::ops::Range;
use std::sync::atomic::{AtomicU8, Ordering};

use wasmtime::{AsContext, AsContextMut, Extern, Memory, SharedMemory, StoreContextMut};

use crate::shm::SharedMemoryLease;

#[derive(Clone)]
pub enum GuestMemory {
    Private(Memory),
    Shared(SharedMemoryLease),
}

impl GuestMemory {
    /// The private memory an instance exports as `memory`. A group member's memory comes only
    /// from its lease (`Programs::instantiate`), never from an export.
    pub fn from_extern(export: Extern) -> Option<Self> {
        export.into_memory().map(Self::Private)
    }

    /// The memory as an import for another instance in the same Store.
    ///
    /// # Safety
    ///
    /// For a shared memory, the Store receiving the import must be owned by a caller that keeps
    /// a lease of this group's backing alive until that Store and every instance in it have
    /// dropped (`SharedMemoryLease::memory_for_admission`).
    pub unsafe fn export_for_admission(&self) -> Extern {
        match self {
            Self::Private(memory) => (*memory).into(),
            // SAFETY: forwarded to the caller's contract above.
            Self::Shared(lease) => unsafe { lease.memory_for_admission() }.clone().into(),
        }
    }

    pub fn is_shared(&self) -> bool {
        matches!(self, Self::Shared(_))
    }

    pub fn len(&self, store: impl AsContext) -> usize {
        match self {
            Self::Private(memory) => memory.data_size(store),
            Self::Shared(lease) => raw(lease).data_size(),
        }
    }

    /// An owned copy of `range`.
    pub fn read(&self, store: impl AsContext, range: Range<usize>) -> Option<Vec<u8>> {
        match self {
            Self::Private(memory) => memory
                .data(store.as_context())
                .get(range)
                .map(<[u8]>::to_vec),
            Self::Shared(lease) => load(raw(lease), range),
        }
    }

    pub fn write(&self, mut store: impl AsContextMut, at: usize, bytes: &[u8]) -> Option<()> {
        let range = at..at.checked_add(bytes.len())?;
        match self {
            Self::Private(memory) => memory
                .data_mut(store.as_context_mut())
                .get_mut(range)?
                .copy_from_slice(bytes),
            Self::Shared(lease) => store_bytes(raw(lease), range.start, bytes)?,
        }
        Some(())
    }

    /// Run `f` over the bytes of each range together with the store's data: borrowed from a
    /// private memory, copied from a shared one.
    pub fn view<'a, T: 'static, R>(
        &self,
        store: impl Into<StoreContextMut<'a, T>>,
        ranges: &[Range<usize>],
        f: impl FnOnce(&[&[u8]], &mut T) -> R,
    ) -> Option<R> {
        match self {
            Self::Private(memory) => {
                let (bytes, data) = memory.data_and_store_mut(store);
                let views = ranges
                    .iter()
                    .map(|range| bytes.get(range.clone()))
                    .collect::<Option<Vec<&[u8]>>>()?;
                Some(f(&views, data))
            }
            Self::Shared(lease) => {
                let copies = ranges
                    .iter()
                    .map(|range| load(raw(lease), range.clone()))
                    .collect::<Option<Vec<_>>>()?;
                let views: Vec<&[u8]> = copies.iter().map(Vec::as_slice).collect();
                let mut store = store.into();
                Some(f(&views, store.data_mut()))
            }
        }
    }

    /// Let `f` produce bytes into `range` and return their count (negative for an error). A
    /// private range is filled in place; for a shared one only the produced prefix is stored.
    pub fn fill<'a, T: 'static>(
        &self,
        store: impl Into<StoreContextMut<'a, T>>,
        range: Range<usize>,
        f: impl FnOnce(&mut [u8], &mut T) -> i32,
    ) -> Option<i32> {
        match self {
            Self::Private(memory) => {
                let (bytes, data) = memory.data_and_store_mut(store);
                Some(f(bytes.get_mut(range)?, data))
            }
            Self::Shared(lease) => {
                raw(lease).data().get(range.clone())?;
                let mut buffer = vec![0; range.len()];
                let mut store = store.into();
                let produced = f(&mut buffer, store.data_mut());
                let count = usize::try_from(produced).unwrap_or(0).min(buffer.len());
                store_bytes(raw(lease), range.start, &buffer[..count])?;
                Some(produced)
            }
        }
    }
}

/// Borrow the shared memory for one host call.
fn raw(lease: &SharedMemoryLease) -> &SharedMemory {
    // SAFETY: the borrow cannot outlive `lease`, which keeps the backing charged, and no clone
    // of the raw memory is made from it.
    unsafe { lease.memory_for_admission() }
}

fn atomic(cell: &UnsafeCell<u8>) -> &AtomicU8 {
    // SAFETY: the cell lives in the stable shared backing and AtomicU8 has u8's layout. Every
    // host access to shared guest bytes goes through these atomics.
    unsafe { AtomicU8::from_ptr(cell.get()) }
}

fn load(memory: &SharedMemory, range: Range<usize>) -> Option<Vec<u8>> {
    let cells = memory.data().get(range)?;
    Some(
        cells
            .iter()
            .map(|cell| atomic(cell).load(Ordering::Relaxed))
            .collect(),
    )
}

fn store_bytes(memory: &SharedMemory, at: usize, bytes: &[u8]) -> Option<()> {
    let cells = memory.data().get(at..at.checked_add(bytes.len())?)?;
    for (cell, byte) in cells.iter().zip(bytes) {
        atomic(cell).store(*byte, Ordering::Relaxed);
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shm::{GroupBackingBudget, GroupPolicy, MemoryGroup};
    use wasmtime::{Config, Engine, MemoryType, Store};

    fn memories(store: &mut Store<u32>) -> [GuestMemory; 2] {
        let private = Memory::new(&mut *store, MemoryType::new(1, None)).unwrap();
        let policy = GroupPolicy {
            maximum_pages: 4,
            ..GroupPolicy::default()
        };
        let group =
            MemoryGroup::new(store.engine(), policy, GroupBackingBudget::default()).unwrap();
        [
            GuestMemory::Private(private),
            GuestMemory::Shared(group.memory_lease()),
        ]
    }

    #[test]
    fn a_shared_export_is_never_adopted_without_its_lease() {
        let store = store();
        let shared = SharedMemory::new(store.engine(), MemoryType::shared(1, 4)).unwrap();
        assert!(GuestMemory::from_extern(shared.into()).is_none());
    }

    fn store() -> Store<u32> {
        let mut config = Config::new();
        config.wasm_threads(true);
        Store::new(&Engine::new(&config).unwrap(), 0)
    }

    #[test]
    fn both_kinds_read_write_view_and_fill_with_the_same_bounds() {
        let mut store = store();
        for memory in memories(&mut store) {
            let end = memory.len(&store);
            assert_eq!(end, 65_536);
            memory.write(&mut store, 10, b"abcdef").unwrap();
            assert_eq!(memory.read(&store, 10..16).unwrap(), b"abcdef");
            assert!(memory.write(&mut store, end - 2, b"abc").is_none());
            assert!(memory.read(&store, end - 2..end + 1).is_none());
            let seen = memory
                .view(&mut store, &[10..12, 14..16], |views, data| {
                    *data += 1;
                    views.concat()
                })
                .unwrap();
            assert_eq!(seen, b"abef");
            assert!(
                memory
                    .view(&mut store, std::slice::from_ref(&(end..end + 1)), |_, _| ())
                    .is_none()
            );
            let produced = memory.fill(&mut store, 20..28, |buffer, data| {
                buffer[..3].copy_from_slice(b"xyz");
                *data += 1;
                3
            });
            assert_eq!(produced, Some(3));
            assert_eq!(memory.read(&store, 20..24).unwrap(), b"xyz\0");
        }
        assert_eq!(*store.data(), 4);
    }

    #[test]
    fn a_shared_fill_stores_only_the_produced_prefix_and_nothing_on_error() {
        let mut store = store();
        let [_, shared] = memories(&mut store);
        shared.write(&mut store, 0, &[7; 8]).unwrap();
        assert_eq!(
            shared.fill(&mut store, 0..8, |buffer, _| {
                buffer.fill(1);
                2
            }),
            Some(2)
        );
        assert_eq!(shared.read(&store, 0..8).unwrap(), [1, 1, 7, 7, 7, 7, 7, 7]);
        assert_eq!(
            shared.fill(&mut store, 0..8, |buffer, _| {
                buffer.fill(9);
                -11
            }),
            Some(-11)
        );
        assert_eq!(shared.read(&store, 0..8).unwrap(), [1, 1, 7, 7, 7, 7, 7, 7]);
    }
}
