//! Stable nested memories over the group's existing fixed regions, one logical region per
//! memory with a lease per member, and the group directory that carries them between members.
use super::*;
use wasmtime::Module;

/// One member's lease of a logical memory. Clones share the member's single region hold.
#[derive(Clone)]
pub(crate) struct NestedMemory(Arc<LogicalMemory>);

#[derive(Clone)]
pub(crate) struct WeakNestedMemory(Weak<LogicalMemory>);

impl WeakNestedMemory {
    pub(crate) fn upgrade(&self) -> Result<NestedMemory, Errno> {
        self.0.upgrade().map(NestedMemory).ok_or(Errno::BadF)
    }
}

struct LogicalMemory {
    group: MemoryGroup,
    member: MemberId,
    region: Arc<SharedRegion>,
}

/// What every member attached to one memory shares. It names the group only by handle, so a
/// directory entry holding it cannot keep the group alive.
pub(super) struct SharedRegion {
    backing: SharedBacking,
    maximum: u32,
    pages: AtomicU32,
    growth: Mutex<()>,
}

impl Drop for LogicalMemory {
    fn drop(&mut self) {
        let _ = self
            .group
            .inner
            .detach(self.member, self.region.backing.handle);
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
            region: Arc::new(SharedRegion {
                backing,
                maximum,
                pages: AtomicU32::new(initial),
                growth: Mutex::new(()),
            }),
        })))
    }

    /// Lease a published memory for `member`: the same region and page count as its sender.
    pub(crate) fn attach(member: &MemberLease, token: u32) -> Result<Self, Errno> {
        let mut state = member.group.lock();
        GroupInner::receives(&state, member.member)?;
        let region = match state.directory.entries.get(&token) {
            Some(Entry::Memory(region)) => region.clone(),
            _ => return Err(Errno::BadF),
        };
        member
            .group
            .add_hold_locked(&mut state, member.member, region.backing.handle)?;
        drop(state);
        Ok(Self(Arc::new(LogicalMemory {
            group: member.group(),
            member: member.member,
            region,
        })))
    }

    /// Publish this memory in the group directory. The entry holds the region whether or not
    /// its sender is still running, until it is withdrawn or the last member stops.
    pub(crate) fn publish(&self) -> Result<u32, Errno> {
        let inner = &self.0.group.inner;
        let mut state = inner.lock();
        GroupInner::receives(&state, self.0.member)?;
        let region = self.0.region.clone();
        let token = state.directory.insert(Entry::Memory(region))?;
        let handle = self.0.region.backing.handle;
        let published = state.regions.get_mut(&handle).ok_or(Errno::BadF);
        match published {
            Ok(region) => region.published += 1,
            Err(error) => {
                state.directory.entries.remove(&token);
                return Err(error);
            }
        }
        Ok(token)
    }

    pub(crate) fn downgrade(&self) -> WeakNestedMemory {
        WeakNestedMemory(Arc::downgrade(&self.0))
    }

    pub(crate) fn base(&self) -> u32 {
        self.0.region.backing.addr
    }

    pub(crate) fn pages(&self) -> u32 {
        self.0.region.pages.load(Ordering::Acquire)
    }

    pub(crate) fn maximum(&self) -> u32 {
        self.0.region.maximum
    }

    pub(crate) fn len(&self) -> u64 {
        u64::from(self.pages()) * u64::from(PAGE_BYTES)
    }

    pub(crate) fn grow(&self, delta: u32) -> Result<u32, Errno> {
        let _growth = self
            .0
            .region
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
        self.0.region.pages.store(next, Ordering::Release);
        Ok(old)
    }

    pub(crate) fn contains(&self, address: u32, width: u32) -> bool {
        address >= self.base()
            && u64::from(address) + u64::from(width) <= u64::from(self.base()) + self.len()
            && address.is_multiple_of(width)
    }
}

/// Publications limit per group. A sender republishes one object under one token.
const MAX_PUBLICATIONS: usize = 4096;

/// The objects members have sent one another. Tokens are never reused within a group, so a
/// stale reference cannot name a later object.
#[derive(Default)]
pub(super) struct Directory {
    entries: HashMap<u32, Entry>,
    next: u32,
}

/// Published shared objects. Dropping one outside the state lock may unmap compiled code.
pub(super) enum Entry {
    Memory(Arc<SharedRegion>),
    Module {
        module: Module,
        description: Arc<str>,
    },
}

impl Directory {
    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }

    fn insert(&mut self, entry: Entry) -> Result<u32, Errno> {
        if self.entries.len() >= MAX_PUBLICATIONS {
            return Err(Errno::Again);
        }
        let token = self.next.checked_add(1).ok_or(Errno::Again)?;
        self.next = token;
        self.entries.insert(token, entry);
        Ok(token)
    }
}

pub(super) fn retire_directory(state: &mut GroupState) -> Vec<Entry> {
    let entries = std::mem::take(&mut state.directory.entries);
    let mut retired = Vec::with_capacity(entries.len());
    for (_, entry) in entries {
        unpublish(state, &entry);
        retired.push(entry);
    }
    retired
}

fn unpublish(state: &mut GroupState, entry: &Entry) {
    let Entry::Memory(region) = entry else {
        return;
    };
    let handle = region.backing.handle;
    let Some(record) = state.regions.get_mut(&handle) else {
        return;
    };
    record.published -= 1;
    GroupInner::maybe_free_region(state, handle);
}

/// Publish a compiled module and the core's opaque description of it.
pub(crate) fn publish_module(
    member: &MemberLease,
    module: Module,
    description: Arc<str>,
) -> Result<u32, Errno> {
    let mut state = member.group.lock();
    GroupInner::receives(&state, member.member)?;
    state.directory.insert(Entry::Module {
        module,
        description,
    })
}

pub(crate) fn attach_module(member: &MemberLease, token: u32) -> Result<(Module, Arc<str>), Errno> {
    let state = member.group.lock();
    GroupInner::receives(&state, member.member)?;
    match state.directory.entries.get(&token) {
        Some(Entry::Module {
            module,
            description,
        }) => Ok((module.clone(), description.clone())),
        _ => Err(Errno::BadF),
    }
}

/// Withdraw an aborted publication. A reference already delivered would find it missing, so
/// only a sender whose message never left may do this.
pub(crate) fn withdraw(member: &MemberLease, token: u32) -> Result<(), Errno> {
    let mut state = member.group.lock();
    GroupInner::receives(&state, member.member)?;
    let entry = state.directory.entries.remove(&token).ok_or(Errno::BadF)?;
    unpublish(&mut state, &entry);
    drop(state);
    drop(entry);
    Ok(())
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

    fn group(budget: GroupBackingBudget) -> MemoryGroup {
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget).unwrap()
    }

    #[test]
    fn a_receiver_shares_one_region_and_grows_the_senders_view() {
        let group = group(GroupBackingBudget::default());
        let sender = group.reserve(1).unwrap().launch();
        let receiver = group.reserve(2).unwrap().launch();
        let memory = NestedMemory::new(&sender, 1, 3).unwrap();
        let token = memory.publish().unwrap();
        let attached = NestedMemory::attach(&receiver, token).unwrap();
        assert_eq!(attached.base(), memory.base());
        assert_eq!(group.snapshot().regions, 1);
        assert_eq!(group.snapshot().holds, 2);
        assert_eq!(attached.grow(1), Ok(1));
        assert_eq!(memory.pages(), 2);
        assert_eq!(memory.grow(1), Ok(2));
        assert_eq!(attached.pages(), 3);
        assert_eq!(attached.grow(1), Err(Errno::NoMem));
        drop(attached);
        drop(memory);
        receiver.physical_stopped();
        sender.physical_stopped();
    }

    #[test]
    fn a_dead_sender_leaves_a_receivers_bytes_and_the_last_stop_releases_them() {
        let budget = GroupBackingBudget::default();
        let group = group(budget.clone());
        let sender = group.reserve(1).unwrap().launch();
        let receiver = group.reserve(2).unwrap().launch();
        let memory = NestedMemory::new(&sender, 1, 2).unwrap();
        group.store32(memory.base(), 77).unwrap();
        let token = memory.publish().unwrap();
        // The sender stops and its Store drops its lease before the message is read.
        sender.physical_stopped();
        drop(memory);
        assert_eq!(group.snapshot().regions, 1);
        let attached = NestedMemory::attach(&receiver, token).unwrap();
        assert_eq!(group.load32(attached.base()), Ok(77));
        assert_eq!(attached.grow(1), Ok(1));
        assert_eq!(group.snapshot().holds, 1);
        drop(attached);
        receiver.physical_stopped();
        let snapshot = group.snapshot();
        assert_eq!(
            (snapshot.members, snapshot.regions, snapshot.holds),
            (0, 0, 0)
        );
        assert_eq!(snapshot.published, 0);
        drop(group);
        assert_eq!(budget.committed_bytes(), 0);
    }

    #[test]
    fn withdrawal_and_stale_or_foreign_tokens_are_refused() {
        let group = group(GroupBackingBudget::default());
        let sender = group.reserve(1).unwrap().launch();
        let receiver = group.reserve(2).unwrap().launch();
        let memory = NestedMemory::new(&sender, 1, 1).unwrap();
        let token = memory.publish().unwrap();
        withdraw(&sender, token).unwrap();
        assert_eq!(group.snapshot().published, 0);
        assert_eq!(
            NestedMemory::attach(&receiver, token).err(),
            Some(Errno::BadF)
        );
        assert_eq!(withdraw(&sender, token).err(), Some(Errno::BadF));
        // Tokens are never reused, and a token of another kind names nothing here.
        let next = memory.publish().unwrap();
        assert_ne!(next, token);
        assert_eq!(attach_module(&receiver, next).err(), Some(Errno::BadF));
        drop(memory);
        // Holds drop with the lease but the publication keeps the region until the group ends.
        assert_eq!(group.snapshot().regions, 1);
        sender.physical_stopped();
        receiver.physical_stopped();
        assert_eq!(group.snapshot().regions, 0);
    }

    #[test]
    fn a_stopped_member_cannot_publish_or_attach_and_keeps_no_hold() {
        let group = group(GroupBackingBudget::default());
        let root = group.reserve(1).unwrap().launch();
        let memory = NestedMemory::new(&root, 1, 1).unwrap();
        let token = memory.publish().unwrap();
        let late = group.reserve(2).unwrap();
        let attached = {
            let lease = late.launch();
            let attached = NestedMemory::attach(&lease, token).unwrap();
            lease.physical_stopped();
            attached
        };
        assert_eq!(group.snapshot().holds, 1);
        // The attached lease of a stopped member is inert: its detach finds nothing to drop.
        assert_eq!(attached.publish().err(), Some(Errno::Search));
        drop(attached);
        assert_eq!(group.snapshot().holds, 1);
        drop(memory);
        root.physical_stopped();
    }
}

#[cfg(test)]
mod lease_tests {
    use super::*;

    #[test]
    fn unpublishing_a_region_releases_it_while_weak_imports_survive() {
        let budget = GroupBackingBudget::default();
        let group =
            MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
        let member = group.reserve(701).unwrap().launch();
        let region = NestedMemory::new(&member, 1, 2).unwrap();
        let weak = region.downgrade();
        assert_eq!(group.snapshot().regions, 1);
        assert_eq!(group.snapshot().committed_bytes, 3 * u64::from(PAGE_BYTES));
        drop(region);
        assert_eq!(weak.upgrade().err(), Some(Errno::BadF));
        assert_eq!(group.snapshot().regions, 0);
        assert_eq!(group.snapshot().holds, 0);
        member.physical_stopped();
        drop(group);
        assert_eq!(budget.committed_bytes(), 0);
    }
}
