//! Stable, session-leased nested memories over the group's existing fixed regions.
use super::*;

#[derive(Clone)]
pub(crate) struct NestedMemory(Arc<LogicalMemory>);

struct LogicalMemory {
    group: MemoryGroup,
    member: MemberId,
    backing: SharedBacking,
    maximum: u32,
    pages: AtomicU32,
    growth: Mutex<()>,
}

impl Drop for LogicalMemory {
    fn drop(&mut self) {
        let _ = self.group.inner.detach(self.member, self.backing.handle);
    }
}

impl NestedMemory {
    pub(crate) fn new(member: &MemberLease, initial: u32, maximum: u32) -> Result<Self, Errno> {
        if initial > maximum || maximum > MAX_GROUP_PAGES {
            return Err(Errno::Inval);
        }
        // Fixed-region allocation commits the entire reservation, including one page
        // for a zero-capacity memory's distinct backing identity. The budget charges it.
        let bytes = maximum.max(1).checked_mul(PAGE_BYTES).ok_or(Errno::NoMem)?;
        let backing = member.group.create(member.member, bytes, PAGE_BYTES)?;
        Ok(Self(Arc::new(LogicalMemory {
            group: member.group(),
            member: member.member,
            backing,
            maximum,
            pages: AtomicU32::new(initial),
            growth: Mutex::new(()),
        })))
    }

    pub(crate) fn base(&self) -> u32 {
        self.0.backing.addr
    }

    pub(crate) fn pages(&self) -> u32 {
        self.0.pages.load(Ordering::Acquire)
    }

    pub(crate) fn maximum(&self) -> u32 {
        self.0.maximum
    }

    pub(crate) fn len(&self) -> u64 {
        u64::from(self.pages()) * u64::from(PAGE_BYTES)
    }

    pub(crate) fn grow(&self, delta: u32) -> Result<u32, Errno> {
        let _growth = self
            .0
            .growth
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let old = self.pages();
        let next = old.checked_add(delta).ok_or(Errno::NoMem)?;
        if next > self.maximum() {
            return Err(Errno::NoMem);
        }
        let chunk = Chunk {
            page: self.base() / PAGE_BYTES + old,
            pages: delta,
        };
        zero_chunk(&self.0.group.inner.backing.memory, chunk);
        self.0.pages.store(next, Ordering::Release);
        Ok(old)
    }

    pub(crate) fn contains(&self, address: u32, width: u32) -> bool {
        address >= self.base()
            && u64::from(address) + u64::from(width) <= u64::from(self.base()) + self.len()
            && address.is_multiple_of(width)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_identity_growth_and_final_release_use_real_backing() {
        let group = MemoryGroup::new(
            &Engine::default(),
            GroupPolicy::default(),
            GroupBackingBudget::default(),
        )
        .unwrap();
        let member = group.reserve(700).unwrap().launch();
        let first = NestedMemory::new(&member, 0, 2).unwrap();
        let second = NestedMemory::new(&member, 0, 0).unwrap();
        assert_ne!(first.base(), second.base());
        assert_eq!(first.len(), 0);
        assert_eq!(group.snapshot().regions, 2);
        assert_eq!(first.grow(1), Ok(0));
        assert_eq!(group.load32(first.base()), Ok(0));
        group.store32(first.base(), 41).unwrap();
        assert_eq!(first.grow(1), Ok(1));
        assert_eq!(group.load32(first.base()), Ok(41));
        assert_eq!(group.load32(first.base() + PAGE_BYTES), Ok(0));
        assert_eq!(first.grow(1), Err(Errno::NoMem));
        assert_eq!(first.grow(u32::MAX), Err(Errno::NoMem));
        assert_eq!(first.pages(), 2);
        let view_lease = first.clone();
        drop(first);
        assert_eq!(group.snapshot().regions, 2);
        drop(view_lease);
        drop(second);
        assert_eq!(group.snapshot().regions, 0);
        member.physical_stopped();
        assert_eq!(group.snapshot().holds, 0);
    }
}
