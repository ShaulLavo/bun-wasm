//! Channel lanes in group memory, for MessagePort traffic between guests of one shared-memory
//! group (QuickJS, JSC and SpiderMonkey built with the shared-group profile).
//!
//! A lane is one 128 KiB region holding two single-writer rings, one per direction. A frame too
//! big for the ring, or one sent while the ring is full, goes to a chain of spill segments. Every
//! region the lane creates is pinned by the group (`runtime_shm.shm_route_group`), so it outlives
//! whichever member created it, and is named by a slot in one group-pinned ledger. The ledger also
//! holds every word that a guest other than a lane's two current end owners may read or write:
//! end ownership, custody of ports in flight, reader-closed, the writer fence, severed and armed.
//! The lane region keeps only what its two owners use: cursors, tail and the rings.
//!
//! Receiving (`drain`) is loads, stores and copies on group memory with no host call, so a frame
//! committed by `postMessage` is visible to the destination's next synchronous receive without
//! the sender, the root or the page running. Staging may call the host and may refuse; commit
//! is infallible stores with one publication point.
//!
//! The algorithm is written against [`Memory`] and [`Host`] so the unit tests run this exact code
//! on a fake group that models member release, member and group pins and handle probes.
//! See `docs/worker-threads.md` ("Group lanes") and
//! `docs/bun-patches/original-adapter-group-lane.md`.
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::SeqCst};

pub(crate) const PAGE: u32 = 65_536;
pub(crate) const EBADF: i32 = 8;

/// Bytes of one ring. Cursors run modulo twice this, since it does not divide 2^32.
pub(crate) const RING: u32 = 65_472;
const PERIOD: u32 = RING * 2;
/// The largest frame stored inline in the ring; larger frames spill.
pub(crate) const RING_FRAME: u32 = 16_384;
/// Spare ring bytes every inline admission keeps, so a spill descriptor always fits.
const HEADROOM: u32 = 16;
const DESCRIPTOR: u32 = u32::MAX;
/// The existing worker frame bound, measured here in UTF-8 bytes.
pub(crate) const MAX_FRAME: u32 = 64 << 20;
const MAX_SEGMENT_PAGES: u32 = 16;
/// Released storage the group keeps for reuse before a sweep returns it to the host.
pub(crate) const POOL_LIMIT: u32 = 1 << 20;

const LANE_BYTES: u32 = PAGE * 2;
pub(crate) const LEDGER_BYTES: u32 = PAGE * 2;
const TAG_BYTES: u32 = 4;

const LEDGER_MAGIC: u32 = u32::from_le_bytes(*b"LEDG");
const LANE_MAGIC: u32 = u32::from_le_bytes(*b"LANE");
const SEGMENT_MAGIC: u32 = u32::from_le_bytes(*b"SPIL");
const VERSION: u32 = 1;

// Ledger header.
const H_MAGIC: u32 = 0;
const H_VERSION: u32 = 4;
const H_PIN: u32 = 8;
/// Ends closed by an exit report whose guest the host has not released yet.
const H_AWAITING: u32 = 12;
/// Bumped by every death declaration, so every guest runs a full sweep after one.
const H_DEATHS: u32 = 16;
/// Bytes in Released slots, which a sweep trims to `POOL_LIMIT`.
const H_POOL: u32 = 20;
const H_TRIM: u32 = 24;

pub(crate) const LANE_SLOTS: u32 = 512;
const LANE_SLOT: u32 = 128;
const LANE_BASE: u32 = 256;
pub(crate) const SMALL_SLOTS: u32 = 2_040;
const SMALL_SLOT: u32 = 32;
const SMALL_BASE: u32 = LANE_BASE + LANE_SLOTS * LANE_SLOT;
const _: () = assert!(SMALL_BASE + SMALL_SLOTS * SMALL_SLOT == LEDGER_BYTES);

// Every slot: claim (u64), pin, address, length.
const CLAIM: u32 = 0;
const PIN: u32 = 8;
const ADDRESS: u32 = 12;
const LENGTH: u32 = 16;
// Lane slot, per side s at 24 + 24s: end (u64), version, custody, custody argument.
const END: u32 = 24;
const SIDE: u32 = 24;
const END_VERSION: u32 = 8;
const CUSTODY: u32 = 12;
const CUSTODY_ARG: u32 = 16;
// Lane slot, per direction d (the ring side d reads) at 72 + 16d.
const DIRECTION: u32 = 72;
const READER_CLOSED: u32 = 0;
const WRITING: u32 = 4;
const SEVERED: u32 = 8;
/// The lane generation while the reader sleeps on this direction, else 0.
const ARMED: u32 = 12;
// Small slot (segment or member cell): link to the owning lane direction.
const LINK: u32 = 20;
const LINK_GEN: u32 = 24;

// Lane region: magic, version, then per direction d at 16 + 32d, then the rings.
const D_BASE: u32 = 16;
const D_STRIDE: u32 = 32;
const D_WRITE: u32 = 0;
const D_READ: u32 = 4;
const D_TAIL: u32 = 8;
const D_TAIL_GEN: u32 = 12;
const D_CURSOR: u32 = 16;
const D_CURSOR_GEN: u32 = 20;
const RINGS: u32 = 128;
const _: () = assert!(RINGS + 2 * RING == LANE_BYTES);

// Segment region header, then frame records.
const S_MAGIC: u32 = 0;
const S_CAPACITY: u32 = 4;
const S_COMMITTED: u32 = 8;
const S_NEXT: u32 = 12;
const S_NEXT_GEN: u32 = 16;
const S_SEALED: u32 = 20;
const S_READ: u32 = 24;
const S_DATA: u32 = 32;

/// Slot phases, the low four bits of a claim word.
pub(crate) mod phase {
    pub const FREE: u32 = 0;
    /// Claimed from Free: the slot may name a pin the creator still owns.
    pub const FRESH: u32 = 1;
    /// Claimed from Released: the slot names a group pin throughout.
    pub const REUSE: u32 = 2;
    pub const STAGED: u32 = 3;
    /// A live lane, or a segment linked into a lane direction.
    pub const LIVE: u32 = 4;
    pub const RELEASED: u32 = 5;
    /// Being returned to the host; the claimant keeps the pin named until unpin settles.
    pub const CLEANING: u32 = 6;
    pub const STARTING: u32 = 7;
    pub const RUNNING: u32 = 8;
}

/// End states, the low four bits of an end word.
pub(crate) mod end {
    pub const OPEN: u32 = 1;
    pub const IN_FLIGHT: u32 = 2;
    pub const CLOSED: u32 = 3;
    /// Logically dead after an exit report; storage waits until the host releases the tag.
    pub const CLOSED_DEAD: u32 = 4;
}

pub(crate) const MAX_COUNT: u32 = (1 << 28) - 1;

/// A claim or end word: a member tag in the high half, a 28-bit generation or epoch and a
/// 4-bit phase or state in the low half. One atomic word publishes all three together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Word {
    pub tag: u32,
    pub count: u32,
    pub kind: u32,
}

impl Word {
    pub(crate) const fn new(tag: u32, count: u32, kind: u32) -> Word {
        Word { tag, count, kind }
    }
    fn pack(self) -> u64 {
        (u64::from(self.tag) << 32) | u64::from((self.count << 4) | self.kind)
    }
    fn unpack(value: u64) -> Word {
        let low = value as u32;
        Word {
            tag: (value >> 32) as u32,
            count: low >> 4,
            kind: low & 15,
        }
    }
}

/// Group memory. `raw` is called only for ranges already checked against `size`.
pub(crate) trait Memory {
    fn size(&self) -> u64;
    fn raw(&self, at: u32, len: u32) -> *mut u8;
}

trait Words: Memory {
    fn word(&self, at: u32) -> &AtomicU32 {
        debug_assert_eq!(at % 4, 0);
        // SAFETY: AtomicU32 has u32's layout, `at` is aligned and inside checked group memory.
        unsafe { &*(self.raw(at, 4) as *const AtomicU32) }
    }
    fn double(&self, at: u32) -> &AtomicU64 {
        debug_assert_eq!(at % 8, 0);
        // SAFETY: as `word`, with every claim and end word 8-byte aligned in the ledger.
        unsafe { &*(self.raw(at, 8) as *const AtomicU64) }
    }
    fn load(&self, at: u32) -> u32 {
        self.word(at).load(SeqCst)
    }
    fn put(&self, at: u32, value: u32) {
        self.word(at).store(value, SeqCst);
    }
    fn cas(&self, at: u32, current: u32, new: u32) -> bool {
        self.word(at)
            .compare_exchange(current, new, SeqCst, SeqCst)
            .is_ok()
    }
    fn add(&self, at: u32, delta: u32) {
        self.word(at).fetch_add(delta, SeqCst);
    }
    fn subtract(&self, at: u32, delta: u32) {
        let _ = self
            .word(at)
            .try_update(SeqCst, SeqCst, |value| Some(value.saturating_sub(delta)));
    }
    fn get(&self, at: u32) -> Word {
        Word::unpack(self.double(at).load(SeqCst))
    }
    fn set(&self, at: u32, value: Word) {
        self.double(at).store(value.pack(), SeqCst);
    }
    fn swap_word(&self, at: u32, current: Word, new: Word) -> bool {
        self.double(at)
            .compare_exchange(current.pack(), new.pack(), SeqCst, SeqCst)
            .is_ok()
    }
    fn copy_out(&self, at: u32, out: &mut [u8]) {
        // SAFETY: the range was checked; a racing writer only touches bytes past a published
        // cursor, which this copy never reads.
        unsafe {
            std::ptr::copy_nonoverlapping(
                self.raw(at, out.len() as u32),
                out.as_mut_ptr(),
                out.len(),
            )
        }
    }
    fn copy_in(&self, at: u32, bytes: &[u8]) {
        // SAFETY: the range was checked and lies beyond the published cursor, so no reader
        // looks at it until a later publication store.
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                self.raw(at, bytes.len() as u32),
                bytes.len(),
            )
        }
    }
}

impl<T: Memory + ?Sized> Words for T {}

/// The six `runtime_shm` region operations a member uses. Errors are positive WASI errnos.
pub(crate) trait Host {
    /// A new region of `len` bytes, page aligned: its handle and group address.
    fn create(&self, len: u32) -> Result<(u32, u32), i32>;
    fn attach(&self, handle: u32) -> Result<u32, i32>;
    fn detach(&self, handle: u32) -> Result<(), i32>;
    fn pin(&self, handle: u32) -> Result<u32, i32>;
    fn route_group(&self, pin: u32) -> Result<(), i32>;
    fn unpin(&self, pin: u32) -> Result<(), i32>;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// No free ledger slot of that kind.
    Ledger,
    Host(i32),
    TooLarge,
    /// The caller does not own that end, or it is not open.
    NotOwned,
    /// A generation or epoch would wrap.
    Exhausted,
    /// The lane failed validation; its reading direction is now closed.
    Corrupt(&'static str),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Ledger => write!(f, "MessagePort lane ledger is full"),
            Refusal::Host(errno) => {
                write!(f, "MessagePort lane storage was refused (errno {errno})")
            }
            Refusal::TooLarge => write!(f, "Worker message exceeds 64 MiB"),
            Refusal::NotOwned => write!(f, "MessagePort lane end is not owned by this thread"),
            Refusal::Exhausted => write!(f, "MessagePort lane identity is exhausted"),
            Refusal::Corrupt(what) => write!(f, "MessagePort lane is corrupt: {what}"),
        }
    }
}

/// A lane by ledger slot and the generation of its current use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LaneRef {
    pub slot: u32,
    pub generation: u32,
}

/// A member cell, the custody of ports sent in `workerData`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CellRef {
    pub index: u32,
    pub generation: u32,
}

/// Who holds a port end while it is in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Custody {
    /// The reading end `side` of a lane: the carrying frame is unread in that direction.
    Lane(LaneRef, u32),
    Cell(CellRef),
    /// A synchronous local delivery in the guest with this tag.
    Tag(u32),
}

const CUSTODY_LANE: u32 = 1 << 30;
const CUSTODY_CELL: u32 = 2 << 30;
const CUSTODY_TAG: u32 = 3 << 30;

fn encode_custody(custody: Custody) -> (u32, u32) {
    match custody {
        Custody::Lane(lane, side) => (CUSTODY_LANE | (lane.slot << 1) | side, lane.generation),
        Custody::Cell(cell) => (CUSTODY_CELL | cell.index, cell.generation),
        Custody::Tag(tag) => (CUSTODY_TAG, tag),
    }
}

fn decode_custody(word: u32, arg: u32) -> Option<Custody> {
    let value = word & !(3 << 30);
    match word & (3 << 30) {
        CUSTODY_LANE => Some(Custody::Lane(
            LaneRef {
                slot: value >> 1,
                generation: arg,
            },
            value & 1,
        )),
        CUSTODY_CELL => Some(Custody::Cell(CellRef {
            index: value,
            generation: arg,
        })),
        CUSTODY_TAG => Some(Custody::Tag(arg)),
        _ => None,
    }
}

/// A frame staged beyond a publication point, published by [`Lanes::commit`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Staged {
    /// The reader closed for good: the commit drops the message, as a closed remote peer does.
    Discard,
    Inline {
        lane: LaneRef,
        dir: u32,
        write: u32,
    },
    FirstSpill {
        lane: LaneRef,
        dir: u32,
        segment: Segment,
        write: u32,
    },
    Append {
        lane: LaneRef,
        dir: u32,
        segment: Segment,
        committed: u32,
    },
    Link {
        lane: LaneRef,
        dir: u32,
        old: Segment,
        segment: Segment,
    },
    ReturnToRing {
        lane: LaneRef,
        dir: u32,
        old: Segment,
        write: u32,
    },
}

/// One store of a commit sequence, in order. The tests interleave readers between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Op {
    Store(u32, u32),
    /// Name the lane direction in a staged segment's slot and move it to Live.
    Link(LaneRef, u32, Segment),
    Finish(LaneRef, u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Segment {
    pub index: u32,
    pub generation: u32,
    pub address: u32,
    pub length: u32,
    claim: Word,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Drain {
    pub frames: Vec<Vec<u8>>,
    /// The quota stopped the drain with committed data left. The lane is not armed.
    pub more: bool,
    /// The writing end is closed or severed and nothing remains.
    pub terminal: bool,
}

/// Where the two parties of one direction meet: lane region words and ring.
#[derive(Clone, Copy)]
struct View {
    lane: LaneRef,
    /// The side that reads this direction.
    dir: u32,
    block: u32,
    ring: u32,
}

enum Step {
    Frame,
    Moved,
    Empty,
}

fn record(len: u32) -> u32 {
    4 + len.next_multiple_of(4)
}

fn distance(write: u32, read: u32) -> u32 {
    (write + PERIOD - read) % PERIOD
}

fn advance(position: u32, bytes: u32) -> u32 {
    (position + bytes) % PERIOD
}

/// One member's view of the group's lanes.
pub(crate) struct Lanes<'a, M: Memory + ?Sized, H: Host + ?Sized> {
    pub mem: &'a M,
    pub host: &'a H,
    pub ledger: u32,
    pub tag: u32,
}

/// Creates this member's tag: a tiny region it holds for life, freed by the host on release.
pub(crate) fn create_tag(host: &(impl Host + ?Sized)) -> Result<u32, Refusal> {
    host.create(TAG_BYTES)
        .map(|(handle, _)| handle)
        .map_err(Refusal::Host)
}

/// Creates, initializes and group-pins the ledger. The group's first member calls it before it
/// reserves any worker, so every later member inherits the same address.
pub(crate) fn create_ledger(
    mem: &(impl Memory + ?Sized),
    host: &(impl Host + ?Sized),
) -> Result<u32, Refusal> {
    let (handle, address) = host.create(LEDGER_BYTES).map_err(Refusal::Host)?;
    if !in_bounds(mem, address, LEDGER_BYTES) {
        let _ = host.detach(handle);
        return Err(Refusal::Corrupt("ledger address"));
    }
    mem.copy_in(address, &vec![0; LEDGER_BYTES as usize]);
    mem.put(address + H_VERSION, VERSION);
    mem.put(address + H_MAGIC, LEDGER_MAGIC);
    let pin = match host.pin(handle) {
        Ok(pin) => pin,
        Err(errno) => {
            let _ = host.detach(handle);
            return Err(Refusal::Host(errno));
        }
    };
    mem.put(address + H_PIN, pin);
    if let Err(errno) = host.route_group(pin) {
        let _ = host.unpin(pin);
        let _ = host.detach(handle);
        return Err(Refusal::Host(errno));
    }
    let _ = host.detach(handle);
    Ok(address)
}

/// Checks an inherited ledger before any other access through it.
pub(crate) fn valid_ledger(mem: &(impl Memory + ?Sized), address: u32) -> bool {
    in_bounds(mem, address, LEDGER_BYTES)
        && mem.load(address + H_MAGIC) == LEDGER_MAGIC
        && mem.load(address + H_VERSION) == VERSION
}

fn in_bounds(mem: &(impl Memory + ?Sized), address: u32, len: u32) -> bool {
    address != 0
        && address.is_multiple_of(PAGE)
        && len != 0
        && u64::from(address) + u64::from(len) <= mem.size()
}

impl<M: Memory + ?Sized, H: Host + ?Sized> Lanes<'_, M, H> {
    fn lane_slot(&self, slot: u32) -> u32 {
        self.ledger + LANE_BASE + slot * LANE_SLOT
    }
    fn small_slot(&self, index: u32) -> u32 {
        self.ledger + SMALL_BASE + index * SMALL_SLOT
    }
    fn end_at(&self, slot: u32, side: u32) -> u32 {
        self.lane_slot(slot) + END + side * SIDE
    }
    fn dir_at(&self, slot: u32, dir: u32) -> u32 {
        self.lane_slot(slot) + DIRECTION + dir * 16
    }

    // ---- Slots: claim, create, release, clean ----

    /// Claims a slot of `len` bytes in one table, reusing a Released one first. The returned
    /// slot is claimed by this member, names a group pin and is detached.
    fn allocate(&self, lanes: bool, len: u32) -> Result<(u32, Word), Refusal> {
        if let Some(found) = self.reuse(lanes, len) {
            return Ok(found);
        }
        let (at, claim) = self.claim_free(lanes)?;
        match self.back(at, len) {
            Ok(()) => Ok((at, claim)),
            Err(error) => {
                self.unclaim_fresh(at, claim);
                Err(error)
            }
        }
    }

    fn slots(&self, lanes: bool) -> impl Iterator<Item = u32> + '_ {
        let (count, at): (u32, fn(&Self, u32) -> u32) = if lanes {
            (LANE_SLOTS, Self::lane_slot)
        } else {
            (SMALL_SLOTS, Self::small_slot)
        };
        (0..count).map(move |index| at(self, index))
    }

    /// Claims the smallest Released slot that fits, so a chain's growing segments each find
    /// their own size again. A lost race looks again.
    fn reuse(&self, lanes: bool, len: u32) -> Option<(u32, Word)> {
        for _ in 0..8 {
            let (at, claim, length) = self.best_fit(lanes, len)?;
            let mine = Word::new(self.tag, claim.count + 1, phase::REUSE);
            if !self.mem.swap_word(at + CLAIM, claim, mine) {
                continue;
            }
            self.mem.subtract(self.ledger + H_POOL, length);
            return Some((at, mine));
        }
        None
    }

    fn best_fit(&self, lanes: bool, len: u32) -> Option<(u32, Word, u32)> {
        let mut best: Option<(u32, Word, u32)> = None;
        for at in self.slots(lanes) {
            let claim = self.mem.get(at + CLAIM);
            if claim.kind != phase::RELEASED || claim.count >= MAX_COUNT {
                continue;
            }
            let length = self.mem.load(at + LENGTH);
            let fits = length >= len && (!lanes || self.lane_epochs_left(at));
            if fits && best.is_none_or(|found| length < found.2) {
                best = Some((at, claim, length));
            }
        }
        best
    }

    fn claim_free(&self, lanes: bool) -> Result<(u32, Word), Refusal> {
        for at in self.slots(lanes) {
            let claim = self.mem.get(at + CLAIM);
            if claim.kind != phase::FREE || claim.count >= MAX_COUNT {
                continue;
            }
            if lanes && !self.lane_epochs_left(at) {
                continue;
            }
            let mine = Word::new(self.tag, claim.count + 1, phase::FRESH);
            if self.mem.swap_word(at + CLAIM, claim, mine) {
                return Ok((at, mine));
            }
        }
        Err(Refusal::Ledger)
    }

    /// A lane slot whose end epochs are near the end of their range is never used again.
    fn lane_epochs_left(&self, at: u32) -> bool {
        (0..2).all(|side| self.mem.get(at + END + side * SIDE).count < MAX_COUNT - 16)
    }

    /// Creates the region for a fresh claim. The slot names the pin before the group owns it.
    fn back(&self, at: u32, len: u32) -> Result<(), Refusal> {
        let (handle, address) = self.host.create(len).map_err(Refusal::Host)?;
        if !in_bounds(self.mem, address, len) {
            let _ = self.host.detach(handle);
            return Err(Refusal::Corrupt("region address"));
        }
        let pin = match self.host.pin(handle) {
            Ok(pin) => pin,
            Err(errno) => {
                let _ = self.host.detach(handle);
                return Err(Refusal::Host(errno));
            }
        };
        self.mem.put(at + ADDRESS, address);
        self.mem.put(at + LENGTH, len);
        self.mem.put(at + PIN, pin);
        if let Err(errno) = self.host.route_group(pin) {
            let _ = self.host.unpin(pin);
            self.mem.put(at + PIN, 0);
            let _ = self.host.detach(handle);
            return Err(Refusal::Host(errno));
        }
        let _ = self.host.detach(handle);
        Ok(())
    }

    fn unclaim_fresh(&self, at: u32, claim: Word) {
        self.mem.put(at + PIN, 0);
        self.mem
            .swap_word(at + CLAIM, claim, Word::new(0, claim.count, phase::FREE));
    }

    /// Returns a slot this member or the lane protocol owns to the reuse pool. A slot above the
    /// pool limit is flagged for the next sweep to return to the host.
    fn release_slot(&self, at: u32, claim: Word) -> bool {
        if !self.mem.swap_word(
            at + CLAIM,
            claim,
            Word::new(0, claim.count, phase::RELEASED),
        ) {
            return false;
        }
        let length = self.mem.load(at + LENGTH);
        self.mem.add(self.ledger + H_POOL, length);
        if length > POOL_LIMIT || self.mem.load(self.ledger + H_POOL) > POOL_LIMIT {
            self.mem.put(self.ledger + H_TRIM, 1);
        }
        true
    }

    /// Finishes returning a slot this member holds in Cleaning. Unpin may be repeated after a
    /// cleaner died: only "bad pin" means already absent. Any other error leaves the slot
    /// exclusive in Cleaning for a later sweep.
    fn finish_cleaning(&self, at: u32, claim: Word) {
        let pin = self.mem.load(at + PIN);
        if pin != 0 {
            match self.host.unpin(pin) {
                Ok(()) => {}
                Err(EBADF) => {}
                Err(_) => return,
            }
            self.mem.put(at + PIN, 0);
        }
        self.mem
            .swap_word(at + CLAIM, claim, Word::new(0, claim.count, phase::FREE));
    }

    fn take_for_cleaning(&self, at: u32, claim: Word) -> Option<Word> {
        let mine = Word::new(self.tag, claim.count, phase::CLEANING);
        self.mem.swap_word(at + CLAIM, claim, mine).then_some(mine)
    }

    // ---- Lanes and their ends ----

    /// Creates a lane with both ends open in this member.
    pub(crate) fn create_lane(&self) -> Result<LaneRef, Refusal> {
        let (at, claim) = self.allocate(true, LANE_BYTES)?;
        let address = self.mem.load(at + ADDRESS);
        self.mem.copy_in(address, &[0; RINGS as usize]);
        self.mem.put(address + 4, VERSION);
        self.mem.put(address, LANE_MAGIC);
        for dir in 0..2 {
            for word in [READER_CLOSED, WRITING, SEVERED, ARMED] {
                self.mem.put(at + DIRECTION + dir * 16 + word, 0);
            }
        }
        for side in 0..2 {
            let end = self.mem.get(at + END + side * SIDE);
            self.mem.put(at + END + side * SIDE + END_VERSION, 0);
            self.mem.put(at + END + side * SIDE + CUSTODY, 0);
            self.mem.set(
                at + END + side * SIDE,
                Word::new(self.tag, end.count + 1, end::OPEN),
            );
        }
        let live = Word::new(self.tag, claim.count, phase::LIVE);
        self.mem.swap_word(at + CLAIM, claim, live);
        Ok(LaneRef {
            slot: (at - self.lane_slot(0)) / LANE_SLOT,
            generation: claim.count,
        })
    }

    fn live(&self, lane: LaneRef) -> Option<Word> {
        if lane.slot >= LANE_SLOTS {
            return None;
        }
        let claim = self.mem.get(self.lane_slot(lane.slot) + CLAIM);
        (claim.kind == phase::LIVE && claim.count == lane.generation).then_some(claim)
    }

    /// This member's open end: the ledger proves ownership before the lane address is read.
    fn owned(&self, lane: LaneRef, side: u32) -> Result<Word, Refusal> {
        if side > 1 || self.live(lane).is_none() {
            return Err(Refusal::NotOwned);
        }
        let end = self.mem.get(self.end_at(lane.slot, side));
        if end.kind != end::OPEN || end.tag != self.tag {
            return Err(Refusal::NotOwned);
        }
        Ok(end)
    }

    fn view(&self, lane: LaneRef, side: u32, dir: u32) -> Result<View, Refusal> {
        self.owned(lane, side)?;
        let slot = self.lane_slot(lane.slot);
        let address = self.mem.load(slot + ADDRESS);
        if !in_bounds(self.mem, address, LANE_BYTES) || self.mem.load(slot + LENGTH) != LANE_BYTES {
            return Err(Refusal::Corrupt("lane address"));
        }
        if self.mem.load(address) != LANE_MAGIC || self.mem.load(address + 4) != VERSION {
            return Err(Refusal::Corrupt("lane header"));
        }
        Ok(View {
            lane,
            dir,
            block: address + D_BASE + dir * D_STRIDE,
            ring: address + RINGS + dir * RING,
        })
    }

    /// The epoch an end will have in flight; refused before anything moves if it would wrap.
    pub(crate) fn transfer_epoch(&self, lane: LaneRef, side: u32) -> Result<u32, Refusal> {
        let end = self.owned(lane, side)?;
        if end.count + 2 > MAX_COUNT {
            return Err(Refusal::Exhausted);
        }
        Ok(end.count + 1)
    }

    /// Commits a port transfer: the end goes in flight under `custody`. Infallible.
    pub(crate) fn transfer(&self, lane: LaneRef, side: u32, custody: Custody) {
        let Ok(end) = self.owned(lane, side) else {
            return;
        };
        let at = self.end_at(lane.slot, side);
        let (word, arg) = encode_custody(custody);
        self.mem.put(at + CUSTODY_ARG, arg);
        self.mem.put(at + CUSTODY, word);
        if !self
            .mem
            .swap_word(at, end, Word::new(0, end.count + 1, end::IN_FLIGHT))
        {
            return;
        }
        // A custody direction closed before this store would never cascade to it.
        if self.custody_closed(custody) {
            self.cascade();
        }
    }

    /// Restores an end in flight to this member. Memory only. False when the end was closed
    /// first or the lane slot moved on: the port is then restored closed.
    pub(crate) fn adopt(&self, lane: LaneRef, side: u32, epoch: u32, version: u32) -> bool {
        if side > 1 || epoch >= MAX_COUNT || self.live(lane).is_none() {
            return false;
        }
        let at = self.end_at(lane.slot, side);
        let expected = Word::new(0, epoch, end::IN_FLIGHT);
        if self.mem.get(at) != expected {
            return false;
        }
        self.mem.put(at + END_VERSION, version);
        self.mem
            .swap_word(at, expected, Word::new(self.tag, epoch + 1, end::OPEN))
    }

    /// The state and adoption version of an end, for the root's retire rule.
    pub(crate) fn end_state(&self, lane: LaneRef, side: u32) -> (u32, u32) {
        if side > 1 || self.live(lane).is_none() {
            return (end::CLOSED, 0);
        }
        let at = self.end_at(lane.slot, side);
        let end = self.mem.get(at);
        (end.kind, self.mem.load(at + END_VERSION))
    }

    /// The root found this end's owner route gone while the end is still open: its peer stops
    /// waiting for it. The orphan's storage is left alone.
    pub(crate) fn sever(&self, lane: LaneRef, side: u32) {
        if side > 1 || self.live(lane).is_none() {
            return;
        }
        self.mem.put(self.dir_at(lane.slot, 1 - side) + SEVERED, 1);
    }

    /// Whether the peer stopped reading what this end writes.
    pub(crate) fn peer_closed(&self, lane: LaneRef, side: u32) -> bool {
        side > 1
            || self.live(lane).is_none()
            || self
                .mem
                .load(self.dir_at(lane.slot, 1 - side) + READER_CLOSED)
                != 0
    }

    /// Begins closing this end: stop reading, dispose of what the direction holds.
    pub(crate) fn close_read(&self, lane: LaneRef, side: u32) {
        if self.owned(lane, side).is_err() {
            return;
        }
        self.close_direction(lane, side);
        self.cascade();
    }

    /// Finishes closing this end. True when the peer was armed and needs a wake hint.
    pub(crate) fn close_end(&self, lane: LaneRef, side: u32) -> bool {
        let Ok(end) = self.owned(lane, side) else {
            return false;
        };
        self.close_direction(lane, side);
        if !self.mem.swap_word(
            self.end_at(lane.slot, side),
            end,
            Word::new(0, end.count + 1, end::CLOSED),
        ) {
            return false;
        }
        let wake = self
            .mem
            .cas(self.dir_at(lane.slot, 1 - side) + ARMED, lane.generation, 0);
        self.cascade();
        self.lane_death(lane.slot);
        wake
    }

    /// Reader-closed, then the writer fence: release the direction's segments unless a writer
    /// is inside a reservation, which then releases them itself.
    fn close_direction(&self, lane: LaneRef, dir: u32) {
        let at = self.dir_at(lane.slot, dir);
        self.mem.put(at + READER_CLOSED, 1);
        if self.mem.load(at + WRITING) == 0 {
            self.release_direction(lane, dir);
        }
    }

    fn release_direction(&self, lane: LaneRef, dir: u32) {
        let link = (lane.slot << 1 | dir) + 1;
        for at in self.slots(false) {
            let claim = self.mem.get(at + CLAIM);
            if claim.kind != phase::LIVE || self.mem.load(at + LINK) != link {
                continue;
            }
            if self.mem.load(at + LINK_GEN) == lane.generation {
                self.release_slot(at, claim);
            }
        }
    }

    /// When both ends are closed and released, nobody can touch the lane any more.
    fn lane_death(&self, slot: u32) {
        let at = self.lane_slot(slot);
        let claim = self.mem.get(at + CLAIM);
        if claim.kind != phase::LIVE {
            return;
        }
        let closed = (0..2).all(|side| self.mem.get(at + END + side * SIDE).kind == end::CLOSED);
        if !closed {
            return;
        }
        let lane = LaneRef {
            slot,
            generation: claim.count,
        };
        self.release_direction(lane, 0);
        self.release_direction(lane, 1);
        self.release_slot(at, claim);
    }

    fn custody_closed(&self, custody: Custody) -> bool {
        match custody {
            Custody::Lane(lane, side) => {
                self.live(lane).is_none()
                    || self.mem.load(self.dir_at(lane.slot, side) + READER_CLOSED) != 0
            }
            Custody::Cell(cell) => !self.cell_open(cell),
            Custody::Tag(_) => false,
        }
    }

    /// Closes every end in flight whose custody is gone, repeating until nothing changes.
    pub(crate) fn cascade(&self) {
        while self.cascade_pass(&mut |_, _| false) {}
    }

    fn cascade_pass(&self, dead_tag: &mut dyn FnMut(&Self, u32) -> bool) -> bool {
        let mut changed = false;
        for slot in 0..LANE_SLOTS {
            for side in 0..2 {
                changed |= self.cascade_end(slot, side, dead_tag);
            }
        }
        changed
    }

    fn cascade_end(
        &self,
        slot: u32,
        side: u32,
        dead_tag: &mut dyn FnMut(&Self, u32) -> bool,
    ) -> bool {
        let claim = self.mem.get(self.lane_slot(slot) + CLAIM);
        if claim.kind != phase::LIVE {
            return false;
        }
        let at = self.end_at(slot, side);
        let end = self.mem.get(at);
        if end.kind != end::IN_FLIGHT {
            return false;
        }
        let custody = decode_custody(self.mem.load(at + CUSTODY), self.mem.load(at + CUSTODY_ARG));
        if self.mem.get(at) != end {
            return false;
        }
        let gone = match custody {
            Some(Custody::Tag(tag)) => dead_tag(self, tag),
            Some(custody) => self.custody_closed(custody),
            None => false,
        };
        if !gone
            || !self
                .mem
                .swap_word(at, end, Word::new(0, end.count + 1, end::CLOSED))
        {
            return false;
        }
        self.close_direction(
            LaneRef {
                slot,
                generation: claim.count,
            },
            side,
        );
        self.lane_death(slot);
        true
    }

    // ---- Member cells ----

    /// A cell for a worker about to be spawned. Its `workerData` ports are in its custody.
    pub(crate) fn create_cell(&self) -> Result<CellRef, Refusal> {
        let (at, claim) = self.claim_free(false)?;
        let starting = Word::new(self.tag, claim.count, phase::STARTING);
        self.mem.swap_word(at + CLAIM, claim, starting);
        Ok(CellRef {
            index: (at - self.small_slot(0)) / SMALL_SLOT,
            generation: claim.count,
        })
    }

    fn cell_open(&self, cell: CellRef) -> bool {
        if cell.index >= SMALL_SLOTS {
            return false;
        }
        let claim = self.mem.get(self.small_slot(cell.index) + CLAIM);
        claim.count == cell.generation
            && (claim.kind == phase::STARTING || claim.kind == phase::RUNNING)
    }

    /// The child records its tag in its cell at startup, before it decodes `workerData`.
    pub(crate) fn register(&self, cell: CellRef) -> bool {
        if cell.index >= SMALL_SLOTS {
            return false;
        }
        let at = self.small_slot(cell.index);
        let claim = self.mem.get(at + CLAIM);
        if claim.kind != phase::STARTING || claim.count != cell.generation {
            return false;
        }
        self.mem.swap_word(
            at + CLAIM,
            claim,
            Word::new(self.tag, claim.count, phase::RUNNING),
        )
    }

    /// The spawner saw the child exit, or its spawn fail. Logical only: the child's ends become
    /// ClosedDead and its storage waits until the host has released it.
    pub(crate) fn exited(&self, cell: CellRef) {
        if !self.cell_open(cell) {
            return;
        }
        let at = self.small_slot(cell.index);
        let claim = self.mem.get(at + CLAIM);
        if claim.kind == phase::RUNNING {
            self.declare_exited(claim.tag);
        }
        self.mem
            .swap_word(at + CLAIM, claim, Word::new(0, claim.count, phase::FREE));
        self.mem.add(self.ledger + H_DEATHS, 1);
        self.cascade();
    }

    fn declare_exited(&self, tag: u32) {
        for slot in 0..LANE_SLOTS {
            for side in 0..2 {
                self.declare_end(slot, side, tag);
            }
        }
    }

    fn declare_end(&self, slot: u32, side: u32, tag: u32) {
        let at = self.end_at(slot, side);
        let end = self.mem.get(at);
        if end.kind != end::OPEN || end.tag != tag || tag == self.tag {
            return;
        }
        if self.mem.get(self.lane_slot(slot) + CLAIM).kind != phase::LIVE {
            return;
        }
        if !self
            .mem
            .swap_word(at, end, Word::new(tag, end.count + 1, end::CLOSED_DEAD))
        {
            return;
        }
        self.mem.add(self.ledger + H_AWAITING, 1);
        self.mem.put(self.dir_at(slot, side) + READER_CLOSED, 1);
    }

    // ---- Sweeps ----

    /// The counter every member compares with its last sweep.
    pub(crate) fn deaths(&self) -> u32 {
        self.mem.load(self.ledger + H_DEATHS)
    }

    /// Returns storage whose users are gone. Cheap when nothing is pending. A full sweep also
    /// probes every tag that holds an open end or a claim, for guests nobody saw exit.
    pub(crate) fn sweep(&self, full: bool) {
        let awaiting = self.mem.load(self.ledger + H_AWAITING) != 0;
        let trim = self.mem.load(self.ledger + H_TRIM) != 0;
        if !full && !awaiting && !trim {
            return;
        }
        let mut probes = Probes::default();
        if full || awaiting {
            self.release_dead(&mut probes, full);
            self.recover_claims(&mut probes);
            while self.cascade_pass(&mut |lanes, tag| probes.dead(lanes.host, lanes.tag, tag)) {}
        }
        self.trim();
    }

    fn release_dead(&self, probes: &mut Probes, full: bool) {
        for slot in 0..LANE_SLOTS {
            for side in 0..2 {
                self.release_end(slot, side, probes, full);
            }
        }
        if full {
            self.release_cells(probes);
        }
    }

    fn release_end(&self, slot: u32, side: u32, probes: &mut Probes, full: bool) {
        let claim = self.mem.get(self.lane_slot(slot) + CLAIM);
        if claim.kind != phase::LIVE {
            return;
        }
        let at = self.end_at(slot, side);
        let end = self.mem.get(at);
        let candidate =
            end.kind == end::CLOSED_DEAD || full && end.kind == end::OPEN && end.tag != self.tag;
        if !candidate || !probes.dead(self.host, self.tag, end.tag) {
            return;
        }
        if !self
            .mem
            .swap_word(at, end, Word::new(0, end.count + 1, end::CLOSED))
        {
            return;
        }
        if end.kind == end::CLOSED_DEAD {
            self.mem.subtract(self.ledger + H_AWAITING, 1);
        }
        self.close_direction(
            LaneRef {
                slot,
                generation: claim.count,
            },
            side,
        );
        self.lane_death(slot);
    }

    fn release_cells(&self, probes: &mut Probes) {
        for at in self.slots(false) {
            let claim = self.mem.get(at + CLAIM);
            let cell = claim.kind == phase::STARTING || claim.kind == phase::RUNNING;
            if !cell || claim.tag == self.tag || !probes.dead(self.host, self.tag, claim.tag) {
                continue;
            }
            self.mem
                .swap_word(at + CLAIM, claim, Word::new(0, claim.count, phase::FREE));
        }
    }

    /// Slots a dead claimant left mid-way. Its host release already dropped whatever it still
    /// owned; group pins it had named are returned or pooled.
    fn recover_claims(&self, probes: &mut Probes) {
        for at in self.slots(true).chain(self.slots(false)) {
            let claim = self.mem.get(at + CLAIM);
            let pending = matches!(
                claim.kind,
                phase::FRESH | phase::REUSE | phase::STAGED | phase::CLEANING
            );
            if !pending {
                continue;
            }
            let mine = claim.tag == self.tag;
            if mine && claim.kind == phase::CLEANING {
                self.finish_cleaning(at, claim);
                continue;
            }
            if mine || !probes.dead(self.host, self.tag, claim.tag) {
                continue;
            }
            self.recover(at, claim);
        }
    }

    fn recover(&self, at: u32, claim: Word) {
        if claim.kind == phase::REUSE || claim.kind == phase::STAGED {
            self.release_slot(at, claim);
            return;
        }
        if let Some(mine) = self.take_for_cleaning(at, claim) {
            self.finish_cleaning(at, mine);
        }
    }

    /// Returns Released storage above the pool limit to the host, largest first.
    fn trim(&self) {
        self.mem.put(self.ledger + H_TRIM, 0);
        let mut released: Vec<(u32, u32, Word)> = self
            .slots(true)
            .chain(self.slots(false))
            .filter_map(|at| {
                let claim = self.mem.get(at + CLAIM);
                (claim.kind == phase::RELEASED).then(|| (self.mem.load(at + LENGTH), at, claim))
            })
            .collect();
        released.sort_unstable_by_key(|item| std::cmp::Reverse(item.0));
        let mut pool: u32 = released.iter().map(|item| item.0).sum();
        for (length, at, claim) in released {
            let keep = length <= POOL_LIMIT && claim.count < MAX_COUNT && pool <= POOL_LIMIT;
            if keep {
                continue;
            }
            let Some(mine) = self.take_for_cleaning(at, claim) else {
                continue;
            };
            self.mem.subtract(self.ledger + H_POOL, length);
            pool -= length;
            self.finish_cleaning(at, mine);
        }
    }

    // ---- Sending ----

    /// Stages `text` for the peer of end `side`. Every allocation and refusal happens here.
    pub(crate) fn reserve(&self, lane: LaneRef, side: u32, text: &[u8]) -> Result<Staged, Refusal> {
        if text.is_empty() || text.len() as u64 > u64::from(MAX_FRAME) {
            return Err(Refusal::TooLarge);
        }
        let view = self.view(lane, side, 1 - side)?;
        let fence = self.dir_at(lane.slot, view.dir);
        self.mem.put(fence + WRITING, 1);
        if self.mem.load(fence + READER_CLOSED) != 0 {
            self.mem.put(fence + WRITING, 0);
            return Ok(Staged::Discard);
        }
        let staged = match self.mem.load(view.block + D_TAIL) {
            0 => self.plan_ring(&view, text),
            tail => self.plan_chain(&view, tail - 1, text),
        };
        if staged.is_err() {
            self.end_writing(lane, view.dir);
        }
        staged
    }

    fn ring_positions(&self, view: &View) -> Result<(u32, u32), Refusal> {
        let write = self.mem.load(view.block + D_WRITE);
        let read = self.mem.load(view.block + D_READ);
        let valid =
            write < PERIOD && read < PERIOD && write.is_multiple_of(4) && read.is_multiple_of(4);
        if !valid || distance(write, read) > RING {
            return Err(Refusal::Corrupt("ring cursor"));
        }
        Ok((write, read))
    }

    fn fits_ring(used: u32, len: u32) -> bool {
        len <= RING_FRAME && used + record(len) + HEADROOM <= RING
    }

    fn plan_ring(&self, view: &View, text: &[u8]) -> Result<Staged, Refusal> {
        let (write, read) = self.ring_positions(view)?;
        let used = distance(write, read);
        let len = text.len() as u32;
        if Self::fits_ring(used, len) {
            let write = self.ring_record(view, write, text);
            return Ok(Staged::Inline {
                lane: view.lane,
                dir: view.dir,
                write,
            });
        }
        if used + HEADROOM > RING {
            return Err(Refusal::Corrupt("ring headroom"));
        }
        let segment = self.new_segment(1, text)?;
        for (index, value) in [DESCRIPTOR, segment.index, segment.generation, 0]
            .into_iter()
            .enumerate()
        {
            self.mem
                .put(view.ring + advance(write, 4 * index as u32) % RING, value);
        }
        Ok(Staged::FirstSpill {
            lane: view.lane,
            dir: view.dir,
            segment,
            write: advance(write, HEADROOM),
        })
    }

    fn ring_record(&self, view: &View, write: u32, text: &[u8]) -> u32 {
        self.mem.put(view.ring + write % RING, text.len() as u32);
        let start = advance(write, 4) % RING;
        let first = text.len().min((RING - start) as usize);
        self.mem.copy_in(view.ring + start, &text[..first]);
        self.mem.copy_in(view.ring, &text[first..]);
        advance(write, record(text.len() as u32))
    }

    fn plan_chain(&self, view: &View, index: u32, text: &[u8]) -> Result<Staged, Refusal> {
        let generation = self.mem.load(view.block + D_TAIL_GEN);
        let old = self.segment(view.lane, view.dir, index, generation)?;
        let len = text.len() as u32;
        let (write, read) = self.ring_positions(view)?;
        let committed = self.mem.load(old.address + S_COMMITTED);
        let caught_up = self.mem.load(view.block + D_CURSOR) == index + 1
            && self.mem.load(view.block + D_CURSOR_GEN) == generation
            && self.mem.load(old.address + S_READ) == committed;
        if caught_up && Self::fits_ring(distance(write, read), len) {
            let write = self.ring_record(view, write, text);
            return Ok(Staged::ReturnToRing {
                lane: view.lane,
                dir: view.dir,
                old,
                write,
            });
        }
        let capacity = old.length - S_DATA;
        if committed <= capacity && record(len) <= capacity - committed {
            self.segment_record(old.address, committed, text);
            let committed = committed + record(len);
            return Ok(Staged::Append {
                lane: view.lane,
                dir: view.dir,
                segment: old,
                committed,
            });
        }
        let pages = (old.length / PAGE * 2).min(MAX_SEGMENT_PAGES);
        let segment = self.new_segment(pages, text)?;
        Ok(Staged::Link {
            lane: view.lane,
            dir: view.dir,
            old,
            segment,
        })
    }

    fn segment_record(&self, address: u32, at: u32, text: &[u8]) {
        self.mem.put(address + S_DATA + at, text.len() as u32);
        self.mem.copy_in(address + S_DATA + at + 4, text);
    }

    /// A staged segment holding `text` as its first committed frame.
    fn new_segment(&self, pages: u32, text: &[u8]) -> Result<Segment, Refusal> {
        let need = (S_DATA + record(text.len() as u32)).div_ceil(PAGE);
        let length = pages.max(need) * PAGE;
        let (at, claim) = self.allocate(false, length)?;
        let address = self.mem.load(at + ADDRESS);
        let length = self.mem.load(at + LENGTH);
        self.mem.copy_in(address, &[0; S_DATA as usize]);
        self.mem.put(address + S_CAPACITY, length - S_DATA);
        self.segment_record(address, 0, text);
        self.mem
            .put(address + S_COMMITTED, record(text.len() as u32));
        self.mem.put(address + S_MAGIC, SEGMENT_MAGIC);
        self.mem.put(at + LINK, 0);
        let staged = Word::new(self.tag, claim.count, phase::STAGED);
        self.mem.swap_word(at + CLAIM, claim, staged);
        Ok(Segment {
            index: (at - self.small_slot(0)) / SMALL_SLOT,
            generation: claim.count,
            address,
            length,
            claim: staged,
        })
    }

    /// The commit sequence: navigation stores, then exactly one publication store, then the
    /// fence release and wake check. Nothing here allocates, calls the host or can fail.
    pub(crate) fn commit_ops(&self, staged: Staged) -> Vec<Op> {
        let block = |lane: LaneRef, dir: u32| {
            let address = self.mem.load(self.lane_slot(lane.slot) + ADDRESS);
            address + D_BASE + dir * D_STRIDE
        };
        match staged {
            Staged::Discard => Vec::new(),
            Staged::Inline { lane, dir, write } => vec![
                Op::Store(block(lane, dir) + D_WRITE, write),
                Op::Finish(lane, dir),
            ],
            Staged::FirstSpill {
                lane,
                dir,
                segment,
                write,
            } => {
                let at = block(lane, dir);
                vec![
                    Op::Link(lane, dir, segment),
                    Op::Store(at + D_TAIL_GEN, segment.generation),
                    Op::Store(at + D_TAIL, segment.index + 1),
                    Op::Store(at + D_WRITE, write),
                    Op::Finish(lane, dir),
                ]
            }
            Staged::Append {
                lane,
                dir,
                segment,
                committed,
            } => {
                vec![
                    Op::Store(segment.address + S_COMMITTED, committed),
                    Op::Finish(lane, dir),
                ]
            }
            Staged::Link {
                lane,
                dir,
                old,
                segment,
            } => {
                let at = block(lane, dir);
                vec![
                    Op::Link(lane, dir, segment),
                    Op::Store(at + D_TAIL_GEN, segment.generation),
                    Op::Store(at + D_TAIL, segment.index + 1),
                    Op::Store(old.address + S_NEXT_GEN, segment.generation),
                    Op::Store(old.address + S_NEXT, segment.index + 1),
                    Op::Finish(lane, dir),
                ]
            }
            Staged::ReturnToRing {
                lane,
                dir,
                old,
                write,
            } => {
                let at = block(lane, dir);
                vec![
                    Op::Store(old.address + S_SEALED, 1),
                    Op::Store(at + D_TAIL, 0),
                    Op::Store(at + D_WRITE, write),
                    Op::Finish(lane, dir),
                ]
            }
        }
    }

    /// Applies one commit store. `Finish` returns whether the reader was armed.
    pub(crate) fn apply(&self, op: Op) -> bool {
        match op {
            Op::Store(at, value) => self.mem.put(at, value),
            Op::Link(lane, dir, segment) => {
                let at = self.small_slot(segment.index);
                self.mem.put(at + LINK_GEN, lane.generation);
                self.mem.put(at + LINK, (lane.slot << 1 | dir) + 1);
                self.mem.swap_word(
                    at + CLAIM,
                    segment.claim,
                    Word::new(segment.claim.tag, segment.generation, phase::LIVE),
                );
            }
            Op::Finish(lane, dir) => {
                self.end_writing(lane, dir);
                return self
                    .mem
                    .cas(self.dir_at(lane.slot, dir) + ARMED, lane.generation, 0);
            }
        }
        false
    }

    /// Publishes a staged frame. True when a wake hint is due.
    pub(crate) fn commit(&self, staged: Staged) -> bool {
        let mut wake = false;
        for op in self.commit_ops(staged) {
            wake |= self.apply(op);
        }
        wake
    }

    /// Abandons a staged frame. The destination never saw any of it.
    pub(crate) fn abort(&self, staged: Staged) {
        let (lane, dir) = match staged {
            Staged::Discard => return,
            Staged::Inline { lane, dir, .. }
            | Staged::Append { lane, dir, .. }
            | Staged::ReturnToRing { lane, dir, .. } => (lane, dir),
            Staged::FirstSpill {
                lane, dir, segment, ..
            }
            | Staged::Link {
                lane, dir, segment, ..
            } => {
                self.release_slot(self.small_slot(segment.index), segment.claim);
                (lane, dir)
            }
        };
        self.end_writing(lane, dir);
    }

    /// The writer half of the fence: a reader that closed while this writer was inside a
    /// reservation left the direction's segments for the writer to release.
    fn end_writing(&self, lane: LaneRef, dir: u32) {
        let fence = self.dir_at(lane.slot, dir);
        self.mem.put(fence + WRITING, 0);
        if self.mem.load(fence + READER_CLOSED) != 0 {
            self.release_direction(lane, dir);
        }
    }

    // ---- Receiving: no host call below ----

    /// A linked segment of this lane direction, validated before its header is trusted.
    fn segment(
        &self,
        lane: LaneRef,
        dir: u32,
        index: u32,
        generation: u32,
    ) -> Result<Segment, Refusal> {
        if index >= SMALL_SLOTS {
            return Err(Refusal::Corrupt("segment index"));
        }
        let at = self.small_slot(index);
        let claim = self.mem.get(at + CLAIM);
        let linked = claim.kind == phase::LIVE
            && claim.count == generation
            && self.mem.load(at + LINK) == (lane.slot << 1 | dir) + 1
            && self.mem.load(at + LINK_GEN) == lane.generation;
        if !linked {
            return Err(Refusal::Corrupt("segment link"));
        }
        let address = self.mem.load(at + ADDRESS);
        let length = self.mem.load(at + LENGTH);
        if length < PAGE || !length.is_multiple_of(PAGE) || !in_bounds(self.mem, address, length) {
            return Err(Refusal::Corrupt("segment address"));
        }
        if self.mem.load(address + S_MAGIC) != SEGMENT_MAGIC
            || self.mem.load(address + S_CAPACITY) != length - S_DATA
        {
            return Err(Refusal::Corrupt("segment header"));
        }
        Ok(Segment {
            index,
            generation,
            address,
            length,
            claim,
        })
    }

    /// Reads up to `limit` frames from the direction end `side` reads.
    pub(crate) fn drain(&self, lane: LaneRef, side: u32, limit: usize) -> Result<Drain, Refusal> {
        let view = self.view(lane, side, side)?;
        let mut out = Drain::default();
        match self.drain_view(&view, limit, &mut out.frames) {
            Ok(more) => out.more = more,
            Err(error) => {
                self.close_direction(lane, side);
                return Err(error);
            }
        }
        if !out.more && self.writer_gone(&view) && !self.has_data(&view)? {
            out.terminal = true;
        }
        Ok(out)
    }

    /// Returns whether committed data remains past the quota.
    fn drain_view(
        &self,
        view: &View,
        limit: usize,
        frames: &mut Vec<Vec<u8>>,
    ) -> Result<bool, Refusal> {
        let armed = self.dir_at(view.lane.slot, view.dir) + ARMED;
        let mut steps = 0;
        while frames.len() < limit {
            steps += 1;
            if steps > 2 * limit + SMALL_SLOTS as usize + 4 {
                return Err(Refusal::Corrupt("segment cycle"));
            }
            match self.step(view, frames)? {
                Step::Frame | Step::Moved => continue,
                Step::Empty => {}
            }
            // Arm, then look again: a commit after this store sees armed and sends a hint.
            self.mem.put(armed, view.lane.generation);
            if !self.has_data(view)? {
                return Ok(false);
            }
        }
        let more = self.has_data(view)?;
        if more {
            self.mem.cas(armed, view.lane.generation, 0);
        }
        Ok(more)
    }

    fn writer_gone(&self, view: &View) -> bool {
        let writer = self.mem.get(self.end_at(view.lane.slot, 1 - view.dir)).kind;
        writer == end::CLOSED
            || writer == end::CLOSED_DEAD
            || self
                .mem
                .load(self.dir_at(view.lane.slot, view.dir) + SEVERED)
                != 0
    }

    fn has_data(&self, view: &View) -> Result<bool, Refusal> {
        let cursor = self.mem.load(view.block + D_CURSOR);
        if cursor == 0 {
            let (write, read) = self.ring_positions(view)?;
            return Ok(write != read);
        }
        let segment = self.segment(
            view.lane,
            view.dir,
            cursor - 1,
            self.mem.load(view.block + D_CURSOR_GEN),
        )?;
        let pending = self.mem.load(segment.address + S_READ)
            != self.mem.load(segment.address + S_COMMITTED)
            || self.mem.load(segment.address + S_NEXT) != 0
            || self.mem.load(segment.address + S_SEALED) != 0;
        Ok(pending || self.mem.get(self.end_at(view.lane.slot, 1 - view.dir)).kind == end::CLOSED)
    }

    fn step(&self, view: &View, frames: &mut Vec<Vec<u8>>) -> Result<Step, Refusal> {
        match self.mem.load(view.block + D_CURSOR) {
            0 => self.ring_step(view, frames),
            cursor => self.segment_step(view, cursor - 1, frames),
        }
    }

    fn ring_step(&self, view: &View, frames: &mut Vec<Vec<u8>>) -> Result<Step, Refusal> {
        let (write, read) = self.ring_positions(view)?;
        let used = distance(write, read);
        if used == 0 {
            return Ok(Step::Empty);
        }
        let head = self.mem.load(view.ring + read % RING);
        if head == DESCRIPTOR {
            if used < HEADROOM {
                return Err(Refusal::Corrupt("descriptor"));
            }
            let index = self.mem.load(view.ring + advance(read, 4) % RING);
            let generation = self.mem.load(view.ring + advance(read, 8) % RING);
            self.segment(view.lane, view.dir, index, generation)?;
            self.mem.put(view.block + D_CURSOR_GEN, generation);
            self.mem.put(view.block + D_CURSOR, index + 1);
            self.mem.put(view.block + D_READ, advance(read, HEADROOM));
            return Ok(Step::Moved);
        }
        if head == 0 || head > RING_FRAME || record(head) > used {
            return Err(Refusal::Corrupt("ring record"));
        }
        let mut frame = vec![0; head as usize];
        let start = advance(read, 4) % RING;
        let first = frame.len().min((RING - start) as usize);
        self.mem.copy_out(view.ring + start, &mut frame[..first]);
        self.mem.copy_out(view.ring, &mut frame[first..]);
        self.mem
            .put(view.block + D_READ, advance(read, record(head)));
        frames.push(frame);
        Ok(Step::Frame)
    }

    fn segment_step(
        &self,
        view: &View,
        index: u32,
        frames: &mut Vec<Vec<u8>>,
    ) -> Result<Step, Refusal> {
        let segment = self.segment(
            view.lane,
            view.dir,
            index,
            self.mem.load(view.block + D_CURSOR_GEN),
        )?;
        let address = segment.address;
        let capacity = segment.length - S_DATA;
        let committed = self.mem.load(address + S_COMMITTED);
        let read = self.mem.load(address + S_READ);
        if committed > capacity
            || read > committed
            || !read.is_multiple_of(4)
            || !committed.is_multiple_of(4)
        {
            return Err(Refusal::Corrupt("segment cursor"));
        }
        if read < committed {
            let len = self.mem.load(address + S_DATA + read);
            if len == 0 || len > MAX_FRAME || record(len) > committed - read {
                return Err(Refusal::Corrupt("segment record"));
            }
            let mut frame = vec![0; len as usize];
            self.mem.copy_out(address + S_DATA + read + 4, &mut frame);
            self.mem.put(address + S_READ, read + record(len));
            frames.push(frame);
            return Ok(Step::Frame);
        }
        self.leave_segment(view, segment)
    }

    /// An exhausted segment. Copy where to go next, then release it; never touch it again.
    fn leave_segment(&self, view: &View, segment: Segment) -> Result<Step, Refusal> {
        let address = segment.address;
        let next = self.mem.load(address + S_NEXT);
        if next != 0 {
            let generation = self.mem.load(address + S_NEXT_GEN);
            self.mem.put(view.block + D_CURSOR_GEN, generation);
            self.mem.put(view.block + D_CURSOR, next);
            self.release_slot(self.small_slot(segment.index), segment.claim);
            return Ok(Step::Moved);
        }
        let sealed = self.mem.load(address + S_SEALED) != 0;
        let writer = self.mem.get(self.end_at(view.lane.slot, 1 - view.dir)).kind;
        if !sealed && writer != end::CLOSED {
            return Ok(Step::Empty);
        }
        // A final unsealed tail is terminal once its writer is closed and released. Look again
        // after seeing that: the writer's last commit came before its close.
        if !sealed
            && (self.mem.load(address + S_COMMITTED) != self.mem.load(address + S_READ)
                || self.mem.load(address + S_NEXT) != 0)
        {
            return Ok(Step::Moved);
        }
        self.mem.put(view.block + D_CURSOR, 0);
        self.release_slot(self.small_slot(segment.index), segment.claim);
        Ok(Step::Moved)
    }
}

/// Liveness of other members' tags within one sweep. A failed attach on a tag means the host
/// released that member; anything else counts as alive.
#[derive(Default)]
struct Probes {
    known: Vec<(u32, bool)>,
}

impl Probes {
    fn dead(&mut self, host: &(impl Host + ?Sized), own: u32, tag: u32) -> bool {
        if tag == 0 || tag == own {
            return false;
        }
        if let Some(&(_, dead)) = self.known.iter().find(|item| item.0 == tag) {
            return dead;
        }
        let dead = match host.attach(tag) {
            Ok(_) => {
                let _ = host.detach(tag);
                false
            }
            Err(errno) => errno == EBADF,
        };
        self.known.push((tag, dead));
        dead
    }
}

/// The guest binding: this member's group memory, its `runtime_shm` imports and the natives
/// `worker_lane.ts` wraps. Raw group addresses stay inside these natives.
#[cfg(bun_wasm_shared_group)]
pub(crate) mod guest {
    use super::*;
    use crate::{
        data::{Args, NativeError, NativeResult, Val},
        natives::Table,
    };
    use std::{cell::RefCell, collections::BTreeMap};

    #[link(wasm_import_module = "runtime_shm")]
    unsafe extern "C" {
        fn shm_create(len: u32, align: u32, out: u32) -> i32;
        fn shm_attach(handle: u32, out: u32) -> i32;
        fn shm_detach(handle: u32) -> i32;
        fn shm_pin(handle: u32, out: u32) -> i32;
        fn shm_route_group(pin: u32) -> i32;
        fn shm_unpin(pin: u32) -> i32;
    }

    struct Group;

    impl Memory for Group {
        fn size(&self) -> u64 {
            core::arch::wasm32::memory_size::<0>() as u64 * u64::from(PAGE)
        }
        fn raw(&self, at: u32, _len: u32) -> *mut u8 {
            at as usize as *mut u8
        }
    }

    fn status(result: i32) -> Result<(), i32> {
        if result < 0 { Err(-result) } else { Ok(()) }
    }

    struct Shm;

    impl Host for Shm {
        fn create(&self, len: u32) -> Result<(u32, u32), i32> {
            let mut out = [0u32; 2];
            status(unsafe { shm_create(len, PAGE, out.as_mut_ptr() as u32) })?;
            Ok((out[0], out[1]))
        }
        fn attach(&self, handle: u32) -> Result<u32, i32> {
            let mut out = [0u32; 1];
            status(unsafe { shm_attach(handle, out.as_mut_ptr() as u32) })?;
            Ok(out[0])
        }
        fn detach(&self, handle: u32) -> Result<(), i32> {
            status(unsafe { shm_detach(handle) })
        }
        fn pin(&self, handle: u32) -> Result<u32, i32> {
            let mut out = [0u32; 1];
            status(unsafe { shm_pin(handle, out.as_mut_ptr() as u32) })?;
            Ok(out[0])
        }
        fn route_group(&self, pin: u32) -> Result<(), i32> {
            status(unsafe { shm_route_group(pin) })
        }
        fn unpin(&self, pin: u32) -> Result<(), i32> {
            status(unsafe { shm_unpin(pin) })
        }
    }

    #[derive(Default)]
    struct State {
        ledger: u32,
        tag: u32,
        deaths: u32,
        next: u32,
        staged: BTreeMap<u32, Staged>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::default();
    }

    fn refused(error: Refusal) -> NativeError {
        NativeError::error(error.to_string())
    }

    /// Runs `f` on this member's lanes. No state borrow survives into it.
    fn with<T>(f: impl FnOnce(&Lanes<'_, Group, Shm>) -> T) -> Result<T, NativeError> {
        let (ledger, tag) = STATE.with(|state| {
            let state = state.borrow();
            (state.ledger, state.tag)
        });
        if ledger == 0 {
            return Err(NativeError::error(
                "MessagePort lanes are not initialized in this thread",
            ));
        }
        Ok(f(&Lanes {
            mem: &Group,
            host: &Shm,
            ledger,
            tag,
        }))
    }

    fn lane(args: &Args<'_>, first: usize) -> Result<(LaneRef, u32), NativeError> {
        let side = args.u32(first + 2)?;
        Ok((
            LaneRef {
                slot: args.u32(first)?,
                generation: args.u32(first + 1)?,
            },
            side,
        ))
    }

    fn pair(first: u32, second: u32) -> Val {
        Val::Array(vec![Val::from(first), Val::from(second)])
    }

    /// The group's first member: its tag, then the ledger every worker inherits.
    fn ledger() -> NativeResult {
        let existing = STATE.with(|state| state.borrow().ledger);
        if existing != 0 {
            return Ok(Val::from(existing));
        }
        let tag = create_tag(&Shm).map_err(refused)?;
        let ledger = create_ledger(&Group, &Shm).map_err(refused)?;
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.tag = tag;
            state.ledger = ledger;
        });
        Ok(Val::from(ledger))
    }

    /// A worker at startup, before it decodes `workerData`.
    fn join(args: Args<'_>) -> NativeResult {
        let ledger = args.u32(0)?;
        if !valid_ledger(&Group, ledger) {
            return Err(NativeError::error("Invalid MessagePort lane ledger"));
        }
        let tag = create_tag(&Shm).map_err(refused)?;
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.tag = tag;
            state.ledger = ledger;
        });
        let cell = CellRef {
            index: args.u32(1)?,
            generation: args.u32(2)?,
        };
        with(|lanes| Val::Bool(lanes.register(cell)))
    }

    /// An allocation refused for want of ledger slots sweeps once and retries.
    fn retry<T>(
        f: impl Fn(&Lanes<'_, Group, Shm>) -> Result<T, Refusal>,
    ) -> Result<T, NativeError> {
        with(|lanes| match f(lanes) {
            Err(Refusal::Ledger | Refusal::Host(_)) => {
                lanes.sweep(true);
                f(lanes)
            }
            other => other,
        })?
        .map_err(refused)
    }

    fn reserve(args: Args<'_>) -> NativeResult {
        let (lane, side) = lane(&args, 0)?;
        let text = args.str(3)?.as_bytes();
        let staged = retry(|lanes| lanes.reserve(lane, side, text))?;
        Ok(Val::from(STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.next = state.next.wrapping_add(1).max(1);
            let id = state.next;
            state.staged.insert(id, staged);
            id
        })))
    }

    fn take(args: &Args<'_>) -> Result<Option<Staged>, NativeError> {
        let id = args.u32(0)?;
        Ok(STATE.with(|state| state.borrow_mut().staged.remove(&id)))
    }

    fn drain(args: Args<'_>) -> NativeResult {
        let (lane, side) = lane(&args, 0)?;
        let limit = args.u32(3)? as usize;
        let drain = with(|lanes| lanes.drain(lane, side, limit))?.map_err(refused)?;
        let mut frames = Vec::with_capacity(drain.frames.len());
        for frame in drain.frames {
            let text =
                String::from_utf8(frame).map_err(|_| refused(Refusal::Corrupt("frame text")))?;
            frames.push(Val::Str(text));
        }
        Ok(Val::Array(vec![
            Val::Array(frames),
            Val::Bool(drain.more),
            Val::Bool(drain.terminal),
        ]))
    }

    fn custody(args: &Args<'_>) -> Result<Custody, NativeError> {
        let (kind, first, second, third) = (args.u32(3)?, args.u32(4)?, args.u32(5)?, args.u32(6)?);
        match kind {
            0 => Ok(Custody::Lane(
                LaneRef {
                    slot: first,
                    generation: second,
                },
                third & 1,
            )),
            1 => Ok(Custody::Cell(CellRef {
                index: first,
                generation: second,
            })),
            _ => Ok(Custody::Tag(STATE.with(|state| state.borrow().tag))),
        }
    }

    /// Sweeps on every event-loop step; a death anywhere in the group makes the next one full.
    fn sweep(full: bool) -> Result<(), NativeError> {
        if STATE.with(|state| state.borrow().ledger) == 0 {
            return Ok(());
        }
        with(|lanes| {
            let deaths = lanes.deaths();
            let seen =
                STATE.with(|state| std::mem::replace(&mut state.borrow_mut().deaths, deaths));
            lanes.sweep(full || deaths != seen);
        })
    }

    pub(crate) fn install(table: &mut Table) {
        table.add("wasm.laneLedger", |_| ledger());
        table.add("wasm.laneJoin", join);
        table.add("wasm.laneCreate", |_| {
            let lane = retry(|lanes| lanes.create_lane())?;
            Ok(pair(lane.slot, lane.generation))
        });
        table.add("wasm.laneCell", |_| {
            let cell = retry(|lanes| lanes.create_cell())?;
            Ok(pair(cell.index, cell.generation))
        });
        table.add("wasm.laneTransferEpoch", |a| {
            let (lane, side) = lane(&a, 0)?;
            Ok(Val::from(
                with(|lanes| lanes.transfer_epoch(lane, side))?.map_err(refused)?,
            ))
        });
        table.add("wasm.laneTransfer", |a| {
            let (lane, side) = lane(&a, 0)?;
            let custody = custody(&a)?;
            with(|lanes| lanes.transfer(lane, side, custody))?;
            Ok(Val::Undefined)
        });
        table.add("wasm.laneAdopt", |a| {
            let (lane, side) = lane(&a, 0)?;
            let (epoch, version) = (a.u32(3)?, a.u32(4)?);
            Ok(Val::Bool(with(|lanes| {
                lanes.adopt(lane, side, epoch, version)
            })?))
        });
        table.add("wasm.laneReserve", reserve);
        table.add("wasm.laneCommit", |a| {
            let Some(staged) = take(&a)? else {
                return Ok(Val::Bool(false));
            };
            Ok(Val::Bool(with(|lanes| lanes.commit(staged))?))
        });
        table.add("wasm.laneAbort", |a| {
            if let Some(staged) = take(&a)? {
                with(|lanes| lanes.abort(staged))?;
            }
            Ok(Val::Undefined)
        });
        table.add("wasm.laneDrain", drain);
        table.add("wasm.laneCloseRead", |a| {
            let (lane, side) = lane(&a, 0)?;
            with(|lanes| lanes.close_read(lane, side))?;
            Ok(Val::Undefined)
        });
        table.add("wasm.laneCloseEnd", |a| {
            let (lane, side) = lane(&a, 0)?;
            Ok(Val::Bool(with(|lanes| lanes.close_end(lane, side))?))
        });
        table.add("wasm.lanePeerClosed", |a| {
            let (lane, side) = lane(&a, 0)?;
            Ok(Val::Bool(with(|lanes| lanes.peer_closed(lane, side))?))
        });
        table.add("wasm.laneEnd", |a| {
            let (lane, side) = lane(&a, 0)?;
            let (state, version) = with(|lanes| lanes.end_state(lane, side))?;
            Ok(pair(state, version))
        });
        table.add("wasm.laneSever", |a| {
            let (lane, side) = lane(&a, 0)?;
            with(|lanes| lanes.sever(lane, side))?;
            Ok(Val::Undefined)
        });
        table.add("wasm.laneExited", |a| {
            let cell = CellRef {
                index: a.u32(0)?,
                generation: a.u32(1)?,
            };
            with(|lanes| lanes.exited(cell))?;
            sweep(true)?;
            Ok(Val::Undefined)
        });
        table.add("wasm.laneSweep", |a| {
            sweep(a.bool(0))?;
            Ok(Val::Undefined)
        });
    }
}

#[cfg(test)]
#[path = "lane/tests.rs"]
mod tests;
