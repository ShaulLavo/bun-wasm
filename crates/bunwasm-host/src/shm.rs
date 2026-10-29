//! Native `runtime_shm` service for one Wasmtime shared memory.
//!
//! J3 owns admitting PIE images and assigning a member lease to a `Host`. Until
//! then the registered imports return `-ENOTSUP`; no private-memory emulation is
//! provided. Nested Wasm users must call this same futex service rather than
//! Wasmtime's separate built-in futex table.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use anyhow::Result;
use wasmtime::{Caller, Engine, Linker, MemoryType, SharedMemory};

use crate::Host;

const PAGE_BYTES: u32 = 65536;
const MAX_GROUP_PAGES: u32 = 65536;
const DEFAULT_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_MEMBERS: usize = 16;
const DEFAULT_REGIONS: usize = 4096;
const DEFAULT_PINS: usize = 4096;
const DEFAULT_WATCHES: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Errno {
    Interrupted = 27,
    Again = 6,
    BadF = 8,
    Inval = 28,
    NoMem = 48,
    NotSup = 58,
    Search = 71,
}

impl Errno {
    fn result(self) -> i32 {
        -(self as i32)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GroupPolicy {
    pub members: usize,
    pub parallelism: u32,
    pub maximum_pages: u32,
    pub regions: usize,
    pub pins: usize,
    pub watches: usize,
}

impl Default for GroupPolicy {
    fn default() -> Self {
        Self {
            members: DEFAULT_MEMBERS,
            parallelism: 1,
            maximum_pages: MAX_GROUP_PAGES,
            regions: DEFAULT_REGIONS,
            pins: DEFAULT_PINS,
            watches: DEFAULT_WATCHES,
        }
    }
}

#[derive(Clone)]
pub struct GroupBackingBudget {
    inner: Arc<Mutex<BudgetState>>,
    limit_bytes: u64,
}

#[derive(Default)]
struct BudgetState {
    committed_bytes: u64,
    peak_bytes: u64,
}

impl Default for GroupBackingBudget {
    fn default() -> Self {
        Self::new(DEFAULT_BUDGET_BYTES)
    }
}

impl GroupBackingBudget {
    pub fn new(limit_bytes: u64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(BudgetState {
                committed_bytes: 0,
                peak_bytes: 0,
            })),
            limit_bytes,
        }
    }

    pub fn committed_bytes(&self) -> u64 {
        self.lock().committed_bytes
    }

    pub fn peak_bytes(&self) -> u64 {
        self.lock().peak_bytes
    }

    fn lock(&self) -> MutexGuard<'_, BudgetState> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn charge(&self, bytes: u64) -> bool {
        let mut state = self.lock();
        let Some(committed) = state.committed_bytes.checked_add(bytes) else {
            return false;
        };
        if committed > self.limit_bytes {
            return false;
        }
        state.committed_bytes = committed;
        state.peak_bytes = state.peak_bytes.max(committed);
        true
    }

    fn force(&self, bytes: u64) {
        let mut state = self.lock();
        state.committed_bytes = state
            .committed_bytes
            .checked_add(bytes)
            .expect("actual group backing exceeds u64 accounting");
        state.peak_bytes = state.peak_bytes.max(state.committed_bytes);
    }

    fn release(&self, bytes: u64) {
        let mut state = self.lock();
        state.committed_bytes = state
            .committed_bytes
            .checked_sub(bytes)
            .expect("group backing released twice");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MemberId {
    index: usize,
    incarnation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RegionHandle(u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PinId(u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WatchId(u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WaiterId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharedBacking {
    pub handle: RegionHandle,
    pub addr: u32,
    pub len: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitResult {
    Ok,
    NotEqual,
    TimedOut,
    Interrupted,
}

impl WaitResult {
    pub fn code(self) -> i32 {
        match self {
            Self::Ok => 0,
            Self::NotEqual => 1,
            Self::TimedOut => 2,
            Self::Interrupted => Errno::Interrupted.result(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GroupSnapshot {
    pub members: usize,
    pub reserved: usize,
    pub retained: usize,
    pub regions: usize,
    pub pins: usize,
    pub holds: usize,
    pub watches: usize,
    pub waiters: usize,
    pub committed_bytes: u64,
    pub free_bytes: u64,
    pub bypassed: bool,
}

#[derive(Clone)]
pub struct MemoryGroup {
    inner: Arc<GroupInner>,
}

struct GroupInner {
    memory: SharedMemory,
    policy: GroupPolicy,
    budget: GroupBackingBudget,
    state: Mutex<GroupState>,
}

impl Drop for GroupInner {
    fn drop(&mut self) {
        let state = self.lock();
        self.budget
            .release(u64::from(state.committed_pages) * u64::from(PAGE_BYTES));
    }
}

struct GroupState {
    members: Vec<Option<Member>>,
    regions: HashMap<RegionHandle, Region>,
    pins: HashMap<PinId, Pin>,
    watches: HashMap<WatchId, Watch>,
    waiters: HashMap<WaiterId, Arc<Waiter>>,
    queues: HashMap<u32, VecDeque<WaiterId>>,
    free: Vec<Chunk>,
    committed_pages: u32,
    next_incarnation: u64,
    next_handle: u32,
    next_pin: u32,
    next_watch: u32,
    next_waiter: u64,
    watch_sequence: u64,
    bypassed: bool,
    ended: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MemberPhase {
    Reserved,
    Launched,
    Retained,
}

struct Member {
    id: MemberId,
    pid: u32,
    phase: MemberPhase,
    holds: HashMap<RegionHandle, u32>,
    chunks: Vec<Chunk>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Chunk {
    page: u32,
    pages: u32,
}

struct Region {
    backing: SharedBacking,
    chunk: Chunk,
    holders: HashMap<MemberId, u32>,
    pins: usize,
}

struct Pin {
    region: RegionHandle,
    owner: MemberId,
}

struct Watch {
    member: MemberId,
    addr: u32,
    expected: i32,
    sequence: u64,
    pending: bool,
}

struct Waiter {
    id: WaiterId,
    member: MemberId,
    addr: u32,
    started: Instant,
    timeout: Option<Duration>,
    state: Mutex<WaitStatus>,
    ready: Condvar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WaitStatus {
    Waiting,
    Woken,
    TimedOut,
    Interrupted,
}

impl Waiter {
    fn expired(&self, now: Instant) -> bool {
        self.timeout
            .is_some_and(|timeout| now.saturating_duration_since(self.started) >= timeout)
    }
}

pub struct MemberReservation {
    group: Arc<GroupInner>,
    member: MemberId,
}

pub struct MemberLease {
    group: Arc<GroupInner>,
    member: MemberId,
}

impl MemoryGroup {
    pub fn new(engine: &Engine, policy: GroupPolicy, budget: GroupBackingBudget) -> Result<Self> {
        anyhow::ensure!(policy.members > 0, "memory group needs a member slot");
        anyhow::ensure!(policy.parallelism > 0, "parallelism must be positive");
        anyhow::ensure!(
            (1..=MAX_GROUP_PAGES).contains(&policy.maximum_pages),
            "memory group maximum exceeds wasm32"
        );
        let memory = SharedMemory::new(engine, MemoryType::shared(1, policy.maximum_pages))?;
        anyhow::ensure!(
            budget.charge(u64::from(PAGE_BYTES)),
            "runtime group backing budget is exhausted"
        );
        let members = std::iter::repeat_with(|| None)
            .take(policy.members)
            .collect();
        let state = GroupState {
            members,
            regions: HashMap::new(),
            pins: HashMap::new(),
            watches: HashMap::new(),
            waiters: HashMap::new(),
            queues: HashMap::new(),
            free: Vec::new(),
            committed_pages: 1,
            next_incarnation: 1,
            next_handle: 1,
            next_pin: 1,
            next_watch: 1,
            next_waiter: 1,
            watch_sequence: 1,
            bypassed: false,
            ended: false,
        };
        Ok(Self {
            inner: Arc::new(GroupInner {
                memory,
                policy,
                budget,
                state: Mutex::new(state),
            }),
        })
    }

    pub fn shared_memory(&self) -> &SharedMemory {
        &self.inner.memory
    }

    pub fn reserve(&self, pid: u32) -> Result<MemberReservation, Errno> {
        let mut state = self.inner.lock();
        self.inner.reconcile(&mut state);
        if state.bypassed {
            return Err(Errno::Inval);
        }
        if state.ended {
            return Err(Errno::Search);
        }
        if state
            .members
            .iter()
            .flatten()
            .any(|member| member.pid == pid)
        {
            return Err(Errno::Inval);
        }
        let Some(index) = state.members.iter().position(Option::is_none) else {
            return Err(Errno::Again);
        };
        let member = MemberId {
            index,
            incarnation: state.next_incarnation,
        };
        state.next_incarnation = state.next_incarnation.wrapping_add(1).max(1);
        state.members[index] = Some(Member {
            id: member,
            pid,
            phase: MemberPhase::Reserved,
            holds: HashMap::new(),
            chunks: Vec::new(),
        });
        Ok(MemberReservation {
            group: self.inner.clone(),
            member,
        })
    }

    pub fn snapshot(&self) -> GroupSnapshot {
        let mut state = self.inner.lock();
        self.inner.reconcile(&mut state);
        let live = state.members.iter().flatten();
        let members = live.clone().count();
        let reserved = live
            .clone()
            .filter(|member| member.phase == MemberPhase::Reserved)
            .count();
        let retained = live
            .filter(|member| member.phase == MemberPhase::Retained)
            .count();
        let holds = state
            .regions
            .values()
            .map(|region| region.holders.values().sum::<u32>() as usize)
            .sum();
        GroupSnapshot {
            members,
            reserved,
            retained,
            regions: state.regions.len(),
            pins: state.pins.len(),
            holds,
            watches: state.watches.len(),
            waiters: state.waiters.len(),
            committed_bytes: u64::from(state.committed_pages) * u64::from(PAGE_BYTES),
            free_bytes: state
                .free
                .iter()
                .map(|chunk| u64::from(chunk.pages) * u64::from(PAGE_BYTES))
                .sum(),
            bypassed: state.bypassed,
        }
    }

    fn prepare_wait32(
        &self,
        member: MemberId,
        addr: u32,
        expected: i32,
        timeout_ns: i64,
    ) -> Result<WaitPreparation, Errno> {
        self.inner
            .prepare_wait(member, addr, 4, expected as u32 as u64, timeout_ns)
    }

    fn prepare_wait64(
        &self,
        member: MemberId,
        addr: u32,
        expected: i64,
        timeout_ns: i64,
    ) -> Result<WaitPreparation, Errno> {
        self.inner
            .prepare_wait(member, addr, 8, expected as u64, timeout_ns)
    }

    #[cfg(test)]
    fn load32(&self, addr: u32) -> Result<i32, Errno> {
        Ok(atomic32(&self.inner.memory, addr)? as i32)
    }

    #[cfg(test)]
    fn store32(&self, addr: u32, value: i32) -> Result<(), Errno> {
        let cell = atomic32_cell(&self.inner.memory, addr)?;
        cell.store(value as u32, Ordering::SeqCst);
        Ok(())
    }

    #[cfg(test)]
    fn store64(&self, addr: u32, value: i64) -> Result<(), Errno> {
        let cell = atomic64_cell(&self.inner.memory, addr)?;
        cell.store(value as u64, Ordering::SeqCst);
        Ok(())
    }
}

impl GroupInner {
    fn lock(&self) -> MutexGuard<'_, GroupState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn reconcile(&self, state: &mut GroupState) {
        let actual_pages = (self.memory.data_size() / PAGE_BYTES as usize) as u32;
        let excess = actual_pages.saturating_sub(state.committed_pages);
        if excess == 0 {
            return;
        }
        self.budget.force(u64::from(excess) * u64::from(PAGE_BYTES));
        state.committed_pages = actual_pages;
        state.bypassed = true;
    }

    fn current_member(state: &GroupState, id: MemberId) -> Result<&Member, Errno> {
        let member = state.members.get(id.index).and_then(Option::as_ref);
        match member {
            Some(member) if member.id == id => Ok(member),
            _ => Err(Errno::Search),
        }
    }

    fn receives(state: &GroupState, id: MemberId) -> Result<(), Errno> {
        let member = Self::current_member(state, id)?;
        if member.phase != MemberPhase::Launched {
            return Err(Errno::Search);
        }
        Ok(())
    }

    fn launch(&self, id: MemberId) -> Result<(), Errno> {
        let mut state = self.lock();
        let member = Self::current_member_mut(&mut state, id)?;
        if member.phase != MemberPhase::Reserved {
            return Err(Errno::Search);
        }
        member.phase = MemberPhase::Launched;
        Ok(())
    }

    fn current_member_mut(state: &mut GroupState, id: MemberId) -> Result<&mut Member, Errno> {
        let member = state.members.get_mut(id.index).and_then(Option::as_mut);
        match member {
            Some(member) if member.id == id => Ok(member),
            _ => Err(Errno::Search),
        }
    }

    fn fail(&self, id: MemberId) {
        let mut state = self.lock();
        if let Ok(member) = Self::current_member_mut(&mut state, id) {
            member.phase = MemberPhase::Retained;
        }
    }

    fn release(&self, id: MemberId) {
        let mut state = self.lock();
        if Self::current_member(&state, id).is_err() {
            return;
        }
        let waiters = state
            .waiters
            .values()
            .filter(|waiter| waiter.member == id)
            .cloned()
            .collect::<Vec<_>>();
        for waiter in waiters {
            Self::remove_waiter_locked(&mut state, &waiter, WaitStatus::Interrupted);
            waiter.ready.notify_one();
        }
        let pins = state
            .pins
            .iter()
            .filter(|(_, pin)| pin.owner == id)
            .map(|(pin, _)| *pin)
            .collect::<Vec<_>>();
        for pin in pins {
            self.drop_pin_locked(&mut state, pin);
        }
        state.watches.retain(|_, watch| watch.member != id);
        let holds = Self::current_member(&state, id)
            .map(|member| member.holds.keys().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        for handle in holds {
            self.release_hold_locked(&mut state, id, handle);
        }
        let chunks = Self::current_member_mut(&mut state, id)
            .map(|member| std::mem::take(&mut member.chunks))
            .unwrap_or_default();
        for chunk in chunks {
            give_chunk(&mut state.free, chunk);
        }
        state.members[id.index] = None;
        if state.members.iter().all(Option::is_none) {
            state.ended = true;
        }
    }

    fn grow(&self, member: MemberId, pages: u32) -> Result<u32, Errno> {
        if pages == 0 || pages > self.policy.maximum_pages {
            return Err(Errno::Inval);
        }
        let mut state = self.lock();
        Self::receives(&state, member)?;
        let chunk = self.take_chunk_locked(&mut state, pages)?;
        let page = chunk.page;
        Self::current_member_mut(&mut state, member)?
            .chunks
            .push(chunk);
        Ok(page)
    }

    fn create(&self, member: MemberId, len: u32, align: u32) -> Result<SharedBacking, Errno> {
        if len == 0 || len > 0x7fff_ffff || !valid_alignment(align) {
            return Err(Errno::Inval);
        }
        let mut state = self.lock();
        Self::receives(&state, member)?;
        if state.regions.len() >= self.policy.regions {
            return Err(Errno::Again);
        }
        let pages = len.div_ceil(PAGE_BYTES);
        let chunk = self.take_chunk_locked(&mut state, pages)?;
        let handle = fresh_region(&mut state);
        let backing = SharedBacking {
            handle,
            addr: chunk.page * PAGE_BYTES,
            len,
        };
        let mut holders = HashMap::new();
        holders.insert(member, 1);
        state.regions.insert(
            handle,
            Region {
                backing,
                chunk,
                holders,
                pins: 0,
            },
        );
        Self::current_member_mut(&mut state, member)?
            .holds
            .insert(handle, 1);
        Ok(backing)
    }

    fn attach(&self, member: MemberId, handle: RegionHandle) -> Result<SharedBacking, Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        let backing = state.regions.get(&handle).ok_or(Errno::BadF)?.backing;
        self.add_hold_locked(&mut state, member, handle)?;
        Ok(backing)
    }

    fn detach(&self, member: MemberId, handle: RegionHandle) -> Result<(), Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        self.drop_hold_locked(&mut state, member, handle)
    }

    fn add_hold_locked(
        &self,
        state: &mut GroupState,
        member: MemberId,
        handle: RegionHandle,
    ) -> Result<(), Errno> {
        let region = state.regions.get(&handle).ok_or(Errno::BadF)?;
        let region_count = region.holders.get(&member).copied().unwrap_or(0);
        region_count.checked_add(1).ok_or(Errno::Again)?;
        let member_count = Self::current_member(state, member)?
            .holds
            .get(&handle)
            .copied()
            .unwrap_or(0);
        member_count.checked_add(1).ok_or(Errno::Again)?;
        state
            .regions
            .get_mut(&handle)
            .ok_or(Errno::BadF)?
            .holders
            .insert(member, region_count + 1);
        Self::current_member_mut(state, member)?
            .holds
            .insert(handle, member_count + 1);
        Ok(())
    }

    fn drop_hold_locked(
        &self,
        state: &mut GroupState,
        member: MemberId,
        handle: RegionHandle,
    ) -> Result<(), Errno> {
        let count = Self::current_member_mut(state, member)?
            .holds
            .get_mut(&handle)
            .ok_or(Errno::BadF)?;
        *count -= 1;
        if *count == 0 {
            Self::current_member_mut(state, member)?
                .holds
                .remove(&handle);
        }
        let region = state.regions.get_mut(&handle).ok_or(Errno::BadF)?;
        let count = region.holders.get_mut(&member).ok_or(Errno::BadF)?;
        *count -= 1;
        if *count == 0 {
            region.holders.remove(&member);
        }
        Self::maybe_free_region(state, handle);
        Ok(())
    }

    fn release_hold_locked(&self, state: &mut GroupState, member: MemberId, handle: RegionHandle) {
        if let Ok(member) = Self::current_member_mut(state, member) {
            member.holds.remove(&handle);
        }
        if let Some(region) = state.regions.get_mut(&handle) {
            region.holders.remove(&member);
        }
        Self::maybe_free_region(state, handle);
    }

    fn pin(&self, member: MemberId, handle: RegionHandle) -> Result<PinId, Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        if !Self::current_member(&state, member)?
            .holds
            .contains_key(&handle)
        {
            return Err(Errno::BadF);
        }
        if state.pins.len() >= self.policy.pins {
            return Err(Errno::Again);
        }
        let id = fresh_pin(&mut state);
        state.pins.insert(
            id,
            Pin {
                region: handle,
                owner: member,
            },
        );
        state.regions.get_mut(&handle).ok_or(Errno::BadF)?.pins += 1;
        Ok(id)
    }

    fn route(&self, member: MemberId, pin: PinId, pid: u32) -> Result<(), Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        let current = state.pins.get(&pin).ok_or(Errno::BadF)?;
        if current.owner != member {
            return Err(Errno::BadF);
        }
        let target = state
            .members
            .iter()
            .flatten()
            .find(|candidate| candidate.pid == pid && candidate.phase != MemberPhase::Retained);
        let target = target.ok_or(Errno::Search)?.id;
        state.pins.get_mut(&pin).ok_or(Errno::BadF)?.owner = target;
        Ok(())
    }

    fn accept(&self, member: MemberId, pin: PinId) -> Result<SharedBacking, Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        let current = state.pins.get(&pin).ok_or(Errno::BadF)?;
        if current.owner != member {
            return Err(Errno::BadF);
        }
        let handle = current.region;
        let backing = state.regions.get(&handle).ok_or(Errno::BadF)?.backing;
        self.add_hold_locked(&mut state, member, handle)?;
        self.drop_pin_locked(&mut state, pin);
        Ok(backing)
    }

    fn unpin(&self, member: MemberId, pin: PinId) -> Result<(), Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        if state.pins.get(&pin).ok_or(Errno::BadF)?.owner != member {
            return Err(Errno::BadF);
        }
        self.drop_pin_locked(&mut state, pin);
        Ok(())
    }

    fn drop_pin_locked(&self, state: &mut GroupState, pin: PinId) {
        let Some(pin) = state.pins.remove(&pin) else {
            return;
        };
        let Some(region) = state.regions.get_mut(&pin.region) else {
            return;
        };
        region.pins -= 1;
        Self::maybe_free_region(state, pin.region);
    }

    fn maybe_free_region(state: &mut GroupState, handle: RegionHandle) {
        let Some(region) = state.regions.get(&handle) else {
            return;
        };
        if !region.holders.is_empty() || region.pins != 0 {
            return;
        }
        let region = state.regions.remove(&handle).expect("region checked above");
        give_chunk(&mut state.free, region.chunk);
    }

    fn take_chunk_locked(&self, state: &mut GroupState, pages: u32) -> Result<Chunk, Errno> {
        if let Some(chunk) = take_free_chunk(&mut state.free, pages) {
            zero_chunk(&self.memory, chunk);
            return Ok(chunk);
        }
        self.reconcile(state);
        if state.bypassed {
            return Err(Errno::NoMem);
        }
        let new_pages = state
            .committed_pages
            .checked_add(pages)
            .ok_or(Errno::NoMem)?;
        if new_pages > self.policy.maximum_pages {
            return Err(Errno::NoMem);
        }
        let bytes = u64::from(pages) * u64::from(PAGE_BYTES);
        if !self.budget.charge(bytes) {
            return Err(Errno::NoMem);
        }
        let page = match self.memory.grow(u64::from(pages)) {
            Ok(page) => page as u32,
            Err(_) => {
                self.budget.release(bytes);
                return Err(Errno::NoMem);
            }
        };
        state.committed_pages = new_pages;
        Ok(Chunk { page, pages })
    }

    fn watch(&self, member: MemberId, addr: u32, expected: i32) -> Result<WatchId, Errno> {
        validate_span(&self.memory, addr, 4)?;
        let mut state = self.lock();
        Self::receives(&state, member)?;
        if state.watches.len() >= self.policy.watches {
            return Err(Errno::Again);
        }
        let id = fresh_watch(&mut state);
        let sequence = state.watch_sequence;
        state.watch_sequence = state.watch_sequence.wrapping_add(1).max(1);
        state.watches.insert(
            id,
            Watch {
                member,
                addr,
                expected,
                sequence,
                pending: true,
            },
        );
        Ok(id)
    }

    fn unwatch(&self, member: MemberId, id: WatchId) -> Result<(), Errno> {
        let mut state = self.lock();
        Self::receives(&state, member)?;
        if state.watches.get(&id).ok_or(Errno::BadF)?.member != member {
            return Err(Errno::BadF);
        }
        state.watches.remove(&id);
        Ok(())
    }

    fn watch_ready(&self, member: MemberId, id: WatchId) -> Result<bool, Errno> {
        let state = self.lock();
        Self::receives(&state, member)?;
        let watch = state.watches.get(&id).ok_or(Errno::BadF)?;
        if watch.member != member {
            return Err(Errno::BadF);
        }
        if !watch.pending {
            return Ok(true);
        }
        Ok(atomic32(&self.memory, watch.addr)? as i32 != watch.expected)
    }

    fn prepare_wait(
        self: &Arc<Self>,
        member: MemberId,
        addr: u32,
        width: u32,
        expected: u64,
        timeout_ns: i64,
    ) -> Result<WaitPreparation, Errno> {
        validate_span(&self.memory, addr, width)?;
        let mut state = self.lock();
        Self::receives(&state, member)?;
        let actual = match width {
            4 => u64::from(atomic32(&self.memory, addr)?),
            8 => atomic64(&self.memory, addr)?,
            _ => return Err(Errno::Inval),
        };
        if actual != expected {
            return Ok(WaitPreparation::NotEqual);
        }
        if timeout_ns == 0 {
            return Ok(WaitPreparation::TimedOut);
        }
        let id = fresh_waiter(&mut state);
        let waiter = Arc::new(Waiter {
            id,
            member,
            addr,
            started: Instant::now(),
            timeout: (timeout_ns >= 0).then(|| Duration::from_nanos(timeout_ns as u64)),
            state: Mutex::new(WaitStatus::Waiting),
            ready: Condvar::new(),
        });
        state.waiters.insert(id, waiter.clone());
        state.queues.entry(addr).or_default().push_back(id);
        Ok(WaitPreparation::Registered(WaitRegistration {
            group: self.clone(),
            waiter,
            settled: false,
        }))
    }

    fn wake(&self, member: MemberId, addr: u32, count: u32) -> Result<u32, Errno> {
        validate_span(&self.memory, addr, 4)?;
        let mut state = self.lock();
        Self::receives(&state, member)?;
        let mut woken = Vec::new();
        let mut live_count = 0;
        let now = Instant::now();
        let sync = state
            .queues
            .get(&addr)
            .map(|queue| queue.iter().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in sync {
            if live_count == count as usize {
                break;
            }
            let Some(waiter) = state.waiters.get(&id).cloned() else {
                continue;
            };
            let status = if waiter.expired(now) {
                WaitStatus::TimedOut
            } else {
                WaitStatus::Woken
            };
            Self::remove_waiter_locked(&mut state, &waiter, status);
            live_count += usize::from(status == WaitStatus::Woken);
            woken.push(waiter);
        }
        let remaining = (count as usize).saturating_sub(live_count);
        let watchers = state
            .watches
            .iter()
            .filter(|(_, watch)| watch.addr == addr && watch.pending)
            .map(|(id, watch)| (*id, watch.sequence))
            .collect::<Vec<_>>();
        let mut watchers = watchers;
        watchers.sort_by_key(|(_, sequence)| *sequence);
        let mut watch_count = 0;
        for (id, _) in watchers.into_iter().take(remaining) {
            if let Some(watch) = state.watches.get_mut(&id) {
                watch.pending = false;
                watch_count += 1;
            }
        }
        drop(state);
        for waiter in &woken {
            waiter.ready.notify_one();
        }
        Ok((live_count + watch_count) as u32)
    }

    fn remove_waiter_locked(state: &mut GroupState, waiter: &Waiter, status: WaitStatus) {
        state.waiters.remove(&waiter.id);
        if let Some(queue) = state.queues.get_mut(&waiter.addr) {
            queue.retain(|id| *id != waiter.id);
            if queue.is_empty() {
                state.queues.remove(&waiter.addr);
            }
        }
        let mut current = waiter
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if *current == WaitStatus::Waiting {
            *current = status;
        }
    }

    fn cancel_wait(&self, member: MemberId, id: WaiterId) -> Result<(), Errno> {
        let mut state = self.lock();
        let waiter = state.waiters.get(&id).cloned().ok_or(Errno::BadF)?;
        if waiter.member != member {
            return Err(Errno::BadF);
        }
        Self::remove_waiter_locked(&mut state, &waiter, WaitStatus::Interrupted);
        drop(state);
        waiter.ready.notify_one();
        Ok(())
    }

    fn cancel_member(&self, member: MemberId) -> usize {
        let mut state = self.lock();
        let waiters = state
            .waiters
            .values()
            .filter(|waiter| waiter.member == member)
            .cloned()
            .collect::<Vec<_>>();
        for waiter in &waiters {
            Self::remove_waiter_locked(&mut state, waiter, WaitStatus::Interrupted);
        }
        drop(state);
        for waiter in &waiters {
            waiter.ready.notify_one();
        }
        waiters.len()
    }

    fn finish_wait(&self, waiter: &Waiter, timed_out: bool) -> WaitResult {
        let mut state = self.lock();
        let current = *waiter
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if current != WaitStatus::Waiting {
            return wait_status(current);
        }
        let status = if timed_out {
            WaitStatus::TimedOut
        } else {
            WaitStatus::Interrupted
        };
        Self::remove_waiter_locked(&mut state, waiter, status);
        wait_status(status)
    }
}

impl MemberReservation {
    pub fn launch(self) -> MemberLease {
        self.group
            .launch(self.member)
            .expect("fresh member reservation");
        MemberLease {
            group: self.group,
            member: self.member,
        }
    }

    pub fn abort(self) {
        self.group.release(self.member);
    }

    pub fn id(&self) -> MemberId {
        self.member
    }
}

impl MemberLease {
    pub fn id(&self) -> MemberId {
        self.member
    }

    pub fn group(&self) -> MemoryGroup {
        MemoryGroup {
            inner: self.group.clone(),
        }
    }

    pub fn failed_physical_stop(&self) {
        self.group.fail(self.member);
    }

    pub fn wait_cancellation(&self) -> MemberWaitCancellation {
        MemberWaitCancellation {
            group: Arc::downgrade(&self.group),
            member: self.member,
        }
    }

    pub fn physical_stopped(self) {
        self.group.release(self.member);
    }

    pub fn prepare_wait32(
        &self,
        addr: u32,
        expected: i32,
        timeout_ns: i64,
    ) -> Result<WaitPreparation, Errno> {
        self.group()
            .prepare_wait32(self.member, addr, expected, timeout_ns)
    }

    pub fn prepare_wait64(
        &self,
        addr: u32,
        expected: i64,
        timeout_ns: i64,
    ) -> Result<WaitPreparation, Errno> {
        self.group()
            .prepare_wait64(self.member, addr, expected, timeout_ns)
    }

    pub fn wait32(&self, addr: u32, expected: i32, timeout_ns: i64) -> Result<WaitResult, Errno> {
        Ok(self.prepare_wait32(addr, expected, timeout_ns)?.wait())
    }

    pub fn wait64(&self, addr: u32, expected: i64, timeout_ns: i64) -> Result<WaitResult, Errno> {
        Ok(self.prepare_wait64(addr, expected, timeout_ns)?.wait())
    }

    pub fn wake(&self, addr: u32, count: u32) -> Result<u32, Errno> {
        self.group.wake(self.member, addr, count)
    }

    pub fn watch(&self, addr: u32, expected: i32) -> Result<WatchId, Errno> {
        self.group.watch(self.member, addr, expected)
    }

    pub fn unwatch(&self, id: WatchId) -> Result<(), Errno> {
        self.group.unwatch(self.member, id)
    }

    pub fn watch_ready(&self, id: WatchId) -> Result<bool, Errno> {
        self.group.watch_ready(self.member, id)
    }
}

pub enum WaitPreparation {
    NotEqual,
    TimedOut,
    Registered(WaitRegistration),
}

impl WaitPreparation {
    pub fn wait(self) -> WaitResult {
        match self {
            Self::NotEqual => WaitResult::NotEqual,
            Self::TimedOut => WaitResult::TimedOut,
            Self::Registered(registration) => registration.wait(),
        }
    }
}

pub struct WaitRegistration {
    group: Arc<GroupInner>,
    waiter: Arc<Waiter>,
    settled: bool,
}

impl WaitRegistration {
    pub fn id(&self) -> WaiterId {
        self.waiter.id
    }

    pub fn cancel_handle(&self) -> WaitCancel {
        WaitCancel {
            group: Arc::downgrade(&self.group),
            member: self.waiter.member,
            id: self.waiter.id,
        }
    }

    pub fn wait(mut self) -> WaitResult {
        let result = self.wait_inner();
        self.settled = true;
        result
    }

    fn wait_inner(&self) -> WaitResult {
        let mut status = self
            .waiter
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        loop {
            if *status != WaitStatus::Waiting {
                return wait_status(*status);
            }
            let Some(timeout) = self.waiter.timeout else {
                status = self
                    .waiter
                    .ready
                    .wait(status)
                    .unwrap_or_else(|poison| poison.into_inner());
                continue;
            };
            let remaining = timeout.saturating_sub(self.waiter.started.elapsed());
            if remaining.is_zero() {
                drop(status);
                return self.group.finish_wait(&self.waiter, true);
            }
            let (next, deadline) = self
                .waiter
                .ready
                .wait_timeout(status, remaining)
                .unwrap_or_else(|poison| poison.into_inner());
            status = next;
            if deadline.timed_out() {
                drop(status);
                return self.group.finish_wait(&self.waiter, true);
            }
        }
    }
}

impl Drop for WaitRegistration {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let _ = self.group.cancel_wait(self.waiter.member, self.waiter.id);
    }
}

pub struct MemberWaitCancellation {
    group: Weak<GroupInner>,
    member: MemberId,
}

impl MemberWaitCancellation {
    pub fn cancel(&self) -> usize {
        let Some(group) = self.group.upgrade() else {
            return 0;
        };
        group.cancel_member(self.member)
    }
}

pub struct WaitCancel {
    group: Weak<GroupInner>,
    member: MemberId,
    id: WaiterId,
}

impl WaitCancel {
    pub fn cancel(&self) -> Result<(), Errno> {
        let Some(group) = self.group.upgrade() else {
            return Ok(());
        };
        group.cancel_wait(self.member, self.id)
    }
}

fn wait_status(status: WaitStatus) -> WaitResult {
    match status {
        WaitStatus::Waiting => unreachable!("wait status settled before reading"),
        WaitStatus::Woken => WaitResult::Ok,
        WaitStatus::TimedOut => WaitResult::TimedOut,
        WaitStatus::Interrupted => WaitResult::Interrupted,
    }
}

fn valid_alignment(align: u32) -> bool {
    align.is_power_of_two() && align <= PAGE_BYTES
}

fn fresh_region(state: &mut GroupState) -> RegionHandle {
    loop {
        let id = RegionHandle(state.next_handle);
        state.next_handle = state.next_handle.wrapping_add(1).max(1);
        if id.0 != 0 && !state.regions.contains_key(&id) {
            return id;
        }
    }
}

fn fresh_pin(state: &mut GroupState) -> PinId {
    loop {
        let id = PinId(state.next_pin);
        state.next_pin = state.next_pin.wrapping_add(1).max(1);
        if id.0 != 0 && !state.pins.contains_key(&id) {
            return id;
        }
    }
}

fn fresh_watch(state: &mut GroupState) -> WatchId {
    loop {
        let id = WatchId(state.next_watch);
        state.next_watch = state.next_watch.wrapping_add(1).max(1);
        if id.0 != 0 && !state.watches.contains_key(&id) {
            return id;
        }
    }
}

fn fresh_waiter(state: &mut GroupState) -> WaiterId {
    loop {
        let id = WaiterId(state.next_waiter);
        state.next_waiter = state.next_waiter.wrapping_add(1).max(1);
        if id.0 != 0 && !state.waiters.contains_key(&id) {
            return id;
        }
    }
}

fn take_free_chunk(free: &mut Vec<Chunk>, pages: u32) -> Option<Chunk> {
    let index = free.iter().position(|chunk| chunk.pages >= pages)?;
    let chunk = free.remove(index);
    if chunk.pages > pages {
        free.push(Chunk {
            page: chunk.page + pages,
            pages: chunk.pages - pages,
        });
        free.sort_by_key(|chunk| chunk.page);
    }
    Some(Chunk {
        page: chunk.page,
        pages,
    })
}

fn give_chunk(free: &mut Vec<Chunk>, chunk: Chunk) {
    free.push(chunk);
    free.sort_by_key(|chunk| chunk.page);
    let mut merged: Vec<Chunk> = Vec::with_capacity(free.len());
    for next in free.drain(..) {
        let Some(previous) = merged.last_mut() else {
            merged.push(next);
            continue;
        };
        if previous.page + previous.pages != next.page {
            merged.push(next);
            continue;
        }
        previous.pages += next.pages;
    }
    *free = merged;
}

fn validate_span(memory: &SharedMemory, addr: u32, width: u32) -> Result<(), Errno> {
    if !addr.is_multiple_of(width) || u64::from(addr) + u64::from(width) > memory.data_size() as u64
    {
        return Err(Errno::Inval);
    }
    Ok(())
}

fn atomic32_cell(memory: &SharedMemory, addr: u32) -> Result<&AtomicU32, Errno> {
    validate_span(memory, addr, 4)?;
    let cell = &memory.data()[addr as usize];
    // SAFETY: the span is 4-byte aligned and in bounds. SharedMemory keeps its
    // base stable, and all service accesses use atomics as its API requires.
    Ok(unsafe { &*cell.get().cast::<AtomicU32>() })
}

fn atomic64_cell(memory: &SharedMemory, addr: u32) -> Result<&AtomicU64, Errno> {
    validate_span(memory, addr, 8)?;
    let cell = &memory.data()[addr as usize];
    // SAFETY: the span is 8-byte aligned and in bounds, with stable shared backing.
    Ok(unsafe { &*cell.get().cast::<AtomicU64>() })
}

fn atomic32(memory: &SharedMemory, addr: u32) -> Result<u32, Errno> {
    Ok(atomic32_cell(memory, addr)?.load(Ordering::SeqCst))
}

fn atomic64(memory: &SharedMemory, addr: u32) -> Result<u64, Errno> {
    Ok(atomic64_cell(memory, addr)?.load(Ordering::SeqCst))
}

fn zero_chunk(memory: &SharedMemory, chunk: Chunk) {
    for page in 0..chunk.pages {
        let base = (chunk.page + page) * PAGE_BYTES;
        for offset in (0..PAGE_BYTES).step_by(4) {
            let cell = atomic32_cell(memory, base + offset).expect("allocated chunk is in bounds");
            cell.store(0, Ordering::Relaxed);
        }
    }
}

fn write_words(memory: &SharedMemory, out: u32, words: &[u32]) {
    for (index, word) in words.iter().enumerate() {
        let addr = out + (index as u32) * 4;
        if let Ok(cell) = atomic32_cell(memory, addr) {
            cell.store(word.to_le(), Ordering::Relaxed);
        }
    }
}

fn output_span(member: &MemberLease, out: u32, words: u32) -> Result<(), Errno> {
    validate_span(&member.group.memory, out, 4)?;
    let bytes = words.checked_mul(4).ok_or(Errno::Inval)?;
    let end = u64::from(out) + u64::from(bytes);
    if end > member.group.memory.data_size() as u64 {
        return Err(Errno::Inval);
    }
    Ok(())
}

pub fn group_grow(member: &MemberLease, pages: u32) -> i32 {
    member
        .group
        .grow(member.member, pages)
        .map_or_else(Errno::result, |page| page as i32)
}

pub fn shm_create(member: &MemberLease, len: u32, align: u32, out: u32) -> i32 {
    if let Err(error) = output_span(member, out, 2) {
        return error.result();
    }
    match member.group.create(member.member, len, align) {
        Ok(backing) => {
            write_words(&member.group.memory, out, &[backing.handle.0, backing.addr]);
            0
        }
        Err(error) => error.result(),
    }
}

pub fn shm_attach(member: &MemberLease, handle: u32, out: u32) -> i32 {
    if let Err(error) = output_span(member, out, 1) {
        return error.result();
    }
    match member.group.attach(member.member, RegionHandle(handle)) {
        Ok(backing) => {
            write_words(&member.group.memory, out, &[backing.addr]);
            0
        }
        Err(error) => error.result(),
    }
}

pub fn shm_detach(member: &MemberLease, handle: u32) -> i32 {
    member
        .group
        .detach(member.member, RegionHandle(handle))
        .map_or_else(Errno::result, |()| 0)
}

pub fn shm_pin(member: &MemberLease, handle: u32, out: u32) -> i32 {
    if let Err(error) = output_span(member, out, 1) {
        return error.result();
    }
    match member.group.pin(member.member, RegionHandle(handle)) {
        Ok(pin) => {
            write_words(&member.group.memory, out, &[pin.0]);
            0
        }
        Err(error) => error.result(),
    }
}

pub fn shm_route(member: &MemberLease, pin: u32, pid: u32) -> i32 {
    member
        .group
        .route(member.member, PinId(pin), pid)
        .map_or_else(Errno::result, |()| 0)
}

pub fn shm_accept(member: &MemberLease, pin: u32, out: u32) -> i32 {
    if let Err(error) = output_span(member, out, 3) {
        return error.result();
    }
    match member.group.accept(member.member, PinId(pin)) {
        Ok(backing) => {
            write_words(
                &member.group.memory,
                out,
                &[backing.handle.0, backing.addr, backing.len],
            );
            0
        }
        Err(error) => error.result(),
    }
}

pub fn shm_unpin(member: &MemberLease, pin: u32) -> i32 {
    member
        .group
        .unpin(member.member, PinId(pin))
        .map_or_else(Errno::result, |()| 0)
}

pub fn futex_wait32(
    member: &MemberLease,
    addr: u32,
    expected: i32,
    timeout_ns: i64,
    cancellation: &Arc<crate::process::Cancellation>,
) -> i32 {
    wait_with_cancellation(
        member.prepare_wait32(addr, expected, timeout_ns),
        cancellation,
    )
}

pub fn futex_wait64(
    member: &MemberLease,
    addr: u32,
    expected: i64,
    timeout_ns: i64,
    cancellation: &Arc<crate::process::Cancellation>,
) -> i32 {
    wait_with_cancellation(
        member.prepare_wait64(addr, expected, timeout_ns),
        cancellation,
    )
}

fn wait_with_cancellation(
    preparation: Result<WaitPreparation, Errno>,
    cancellation: &Arc<crate::process::Cancellation>,
) -> i32 {
    let preparation = match preparation {
        Ok(preparation) => preparation,
        Err(error) => return error.result(),
    };
    let registration = match preparation {
        WaitPreparation::Registered(registration) => registration,
        other => return other.wait().code(),
    };
    let cancel = registration.cancel_handle();
    let _guard = cancellation.register_blocking(move || {
        let _ = cancel.cancel();
    });
    registration.wait().code()
}

pub fn futex_wake(member: &MemberLease, addr: u32, count: u32) -> i32 {
    member
        .wake(addr, count)
        .map_or_else(Errno::result, |count| count as i32)
}

pub fn futex_watch(member: &MemberLease, addr: u32, expected: i32, out: u32) -> i32 {
    if let Err(error) = output_span(member, out, 1) {
        return error.result();
    }
    match member.watch(addr, expected) {
        Ok(id) => {
            write_words(&member.group.memory, out, &[id.0]);
            0
        }
        Err(error) => error.result(),
    }
}

pub fn futex_unwatch(member: &MemberLease, id: u32) -> i32 {
    member
        .unwatch(WatchId(id))
        .map_or_else(Errno::result, |()| 0)
}

pub fn parallelism(member: &MemberLease) -> i32 {
    member.group.policy.parallelism as i32
}

fn host_member(host: &Host) -> Result<&MemberLease, i32> {
    host.shm.as_ref().ok_or(Errno::NotSup.result())
}

fn host_wait32(host: &Host, addr: u32, expected: i32, timeout_ns: i64) -> i32 {
    match host_member(host) {
        Ok(member) => futex_wait32(member, addr, expected, timeout_ns, &host.cancel),
        Err(error) => error,
    }
}

fn host_wait64(host: &Host, addr: u32, expected: i64, timeout_ns: i64) -> i32 {
    match host_member(host) {
        Ok(member) => futex_wait64(member, addr, expected, timeout_ns, &host.cancel),
        Err(error) => error,
    }
}

/// Registers the exact J1 ABI. J3 must install both the imported shared memory
/// and its matching member lease before instantiation; `Host::shm = None` is an
/// explicit unsupported boundary, not a private-memory fallback.
pub fn add_imports(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "runtime_shm",
        "group_grow",
        |caller: Caller<'_, Host>, pages: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| group_grow(member, pages))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_create",
        |caller: Caller<'_, Host>, len: u32, align: u32, out: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| shm_create(member, len, align, out))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_attach",
        |caller: Caller<'_, Host>, handle: u32, out: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| shm_attach(member, handle, out))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_detach",
        |caller: Caller<'_, Host>, handle: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| shm_detach(member, handle))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_pin",
        |caller: Caller<'_, Host>, handle: u32, out: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| shm_pin(member, handle, out))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_route",
        |caller: Caller<'_, Host>, pin: u32, pid: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| shm_route(member, pin, pid))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_accept",
        |caller: Caller<'_, Host>, pin: u32, out: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| shm_accept(member, pin, out))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "shm_unpin",
        |caller: Caller<'_, Host>, pin: u32| {
            host_member(caller.data()).map_or_else(|error| error, |member| shm_unpin(member, pin))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "futex_wait32",
        |caller: Caller<'_, Host>, addr: u32, expected: i32, timeout_ns: i64| {
            host_wait32(caller.data(), addr, expected, timeout_ns)
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "futex_wait64",
        |caller: Caller<'_, Host>, addr: u32, expected: i64, timeout_ns: i64| {
            host_wait64(caller.data(), addr, expected, timeout_ns)
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "futex_wake",
        |caller: Caller<'_, Host>, addr: u32, count: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| futex_wake(member, addr, count))
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "futex_watch",
        |caller: Caller<'_, Host>, addr: u32, expected: i32, out: u32| {
            host_member(caller.data()).map_or_else(
                |error| error,
                |member| futex_watch(member, addr, expected, out),
            )
        },
    )?;
    linker.func_wrap(
        "runtime_shm",
        "futex_unwatch",
        |caller: Caller<'_, Host>, id: u32| {
            host_member(caller.data())
                .map_or_else(|error| error, |member| futex_unwatch(member, id))
        },
    )?;
    linker.func_wrap("runtime_shm", "parallelism", |caller: Caller<'_, Host>| {
        host_member(caller.data()).map_or_else(|error| error, parallelism)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests;
