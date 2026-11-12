//! The real lane algorithm on a fake group. The fake follows both hosts' region rules: a
//! region frees only with no holders and no pins; member release drops that member's holds
//! and member-owned pins; group pins drop only when the last member is released; handles and
//! pins never repeat; a released member's calls fail with EBADF.
use super::*;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

const EAGAIN: i32 = 6;
const ENOMEM: i32 = 48;

struct Buffer {
    words: Box<[AtomicU64]>,
}

impl Buffer {
    fn new(pages: u32) -> Buffer {
        Buffer {
            words: (0..pages as usize * PAGE as usize / 8)
                .map(|_| AtomicU64::new(0))
                .collect(),
        }
    }
}

impl Memory for Buffer {
    fn size(&self) -> u64 {
        self.words.len() as u64 * 8
    }
    fn raw(&self, at: u32, len: u32) -> *mut u8 {
        assert!(
            u64::from(at) + u64::from(len) <= self.size(),
            "access outside group memory"
        );
        // SAFETY: inside the allocation; AtomicU64 permits writes through shared pointers.
        unsafe { (self.words.as_ptr() as *mut u8).add(at as usize) }
    }
}

/// Memory for a guest that owns no end of the lanes in `forbidden`: touching one fails.
struct Guarded<'a> {
    inner: &'a Buffer,
    forbidden: Vec<(u32, u32)>,
}

impl Memory for Guarded<'_> {
    fn size(&self) -> u64 {
        self.inner.size()
    }
    fn raw(&self, at: u32, len: u32) -> *mut u8 {
        for &(start, bytes) in &self.forbidden {
            assert!(
                at + len <= start || at >= start + bytes,
                "a non-owner touched lane memory at {at}"
            );
        }
        self.inner.raw(at, len)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Owner {
    Member(u32),
    Group,
}

struct Region {
    page: u32,
    pages: u32,
    holders: BTreeMap<u32, u32>,
    pins: u32,
}

#[derive(Default)]
struct State {
    regions: BTreeMap<u32, Region>,
    pins: BTreeMap<u32, (u32, Owner)>,
    members: BTreeMap<u32, bool>,
    used: Vec<bool>,
    next_handle: u32,
    next_pin: u32,
    next_member: u32,
    fail: Vec<(&'static str, i32)>,
    calls: usize,
    unpinned: usize,
    ended: bool,
}

struct Group {
    mem: Buffer,
    state: Mutex<State>,
}

impl Group {
    fn new(pages: u32) -> Arc<Group> {
        let mut used = vec![false; pages as usize];
        used[0] = true;
        Arc::new(Group {
            mem: Buffer::new(pages),
            state: Mutex::new(State {
                used,
                next_handle: 1,
                next_pin: 1,
                next_member: 1,
                ..State::default()
            }),
        })
    }

    fn join(self: &Arc<Group>) -> Guest {
        let mut state = self.state.lock().unwrap();
        let id = state.next_member;
        state.next_member += 1;
        state.members.insert(id, true);
        Guest {
            group: self.clone(),
            id,
        }
    }

    /// The host's member release: what a stop or kill settles to.
    fn release(&self, id: u32) {
        let mut state = self.state.lock().unwrap();
        state.members.insert(id, false);
        let held: Vec<u32> = state.regions.keys().copied().collect();
        for handle in held {
            state.regions.get_mut(&handle).unwrap().holders.remove(&id);
        }
        let owned: Vec<u32> = state
            .pins
            .iter()
            .filter(|(_, pin)| pin.1 == Owner::Member(id))
            .map(|(id, _)| *id)
            .collect();
        for pin in owned {
            drop_pin(&mut state, pin);
        }
        if !state.members.values().any(|live| *live) {
            state.ended = true;
            let all: Vec<u32> = state.pins.keys().copied().collect();
            for pin in all {
                drop_pin(&mut state, pin);
            }
        }
        sweep_regions(&mut state);
    }

    fn fail_next(&self, op: &'static str, errno: i32) {
        self.state.lock().unwrap().fail.push((op, errno));
    }

    fn counts(&self) -> (usize, usize) {
        let state = self.state.lock().unwrap();
        (state.regions.len(), state.pins.len())
    }

    fn calls(&self) -> usize {
        self.state.lock().unwrap().calls
    }

    fn regions(&self) -> Vec<(u32, u32)> {
        let state = self.state.lock().unwrap();
        state
            .regions
            .values()
            .map(|region| (region.page * PAGE, region.pages * PAGE))
            .collect()
    }
}

fn drop_pin(state: &mut State, pin: u32) {
    if let Some((region, _)) = state.pins.remove(&pin)
        && let Some(region) = state.regions.get_mut(&region)
    {
        region.pins -= 1;
    }
}

fn sweep_regions(state: &mut State) {
    let free: Vec<u32> = state
        .regions
        .iter()
        .filter(|(_, region)| region.holders.is_empty() && region.pins == 0)
        .map(|(handle, _)| *handle)
        .collect();
    for handle in free {
        let region = state.regions.remove(&handle).unwrap();
        for page in region.page..region.page + region.pages {
            state.used[page as usize] = false;
        }
    }
}

struct Guest {
    group: Arc<Group>,
    id: u32,
}

impl Guest {
    fn enter(&self, op: &'static str) -> Result<std::sync::MutexGuard<'_, State>, i32> {
        let mut state = self.group.state.lock().unwrap();
        state.calls += 1;
        if let Some(index) = state.fail.iter().position(|item| item.0 == op) {
            return Err(state.fail.remove(index).1);
        }
        if state.members.get(&self.id) != Some(&true) {
            return Err(EBADF);
        }
        Ok(state)
    }
}

impl Host for Guest {
    fn create(&self, len: u32) -> Result<(u32, u32), i32> {
        let mut state = self.enter("create")?;
        let pages = len.div_ceil(PAGE).max(1);
        let page = (1..state.used.len() as u32)
            .find(|&start| {
                (start..start + pages).all(|page| state.used.get(page as usize) == Some(&false))
            })
            .ok_or(ENOMEM)?;
        for at in page..page + pages {
            state.used[at as usize] = true;
        }
        self.group
            .mem
            .copy_in(page * PAGE, &vec![0; (pages * PAGE) as usize]);
        let handle = state.next_handle;
        state.next_handle += 1;
        state.regions.insert(
            handle,
            Region {
                page,
                pages,
                holders: BTreeMap::from([(self.id, 1)]),
                pins: 0,
            },
        );
        Ok((handle, page * PAGE))
    }
    fn attach(&self, handle: u32) -> Result<u32, i32> {
        let mut state = self.enter("attach")?;
        let region = state.regions.get_mut(&handle).ok_or(EBADF)?;
        *region.holders.entry(self.id).or_default() += 1;
        Ok(region.page * PAGE)
    }
    fn detach(&self, handle: u32) -> Result<(), i32> {
        let mut state = self.enter("detach")?;
        let region = state.regions.get_mut(&handle).ok_or(EBADF)?;
        let count = region.holders.get_mut(&self.id).ok_or(EBADF)?;
        *count -= 1;
        if *count == 0 {
            region.holders.remove(&self.id);
        }
        sweep_regions(&mut state);
        Ok(())
    }
    fn pin(&self, handle: u32) -> Result<u32, i32> {
        let mut state = self.enter("pin")?;
        let held = state
            .regions
            .get(&handle)
            .is_some_and(|region| region.holders.contains_key(&self.id));
        if !held {
            return Err(EBADF);
        }
        let pin = state.next_pin;
        state.next_pin += 1;
        state.pins.insert(pin, (handle, Owner::Member(self.id)));
        state.regions.get_mut(&handle).unwrap().pins += 1;
        Ok(pin)
    }
    fn route_group(&self, pin: u32) -> Result<(), i32> {
        let mut state = self.enter("route_group")?;
        let entry = state.pins.get_mut(&pin).ok_or(EBADF)?;
        if entry.1 != Owner::Member(self.id) {
            return Err(EBADF);
        }
        entry.1 = Owner::Group;
        Ok(())
    }
    fn unpin(&self, pin: u32) -> Result<(), i32> {
        let mut state = self.enter("unpin")?;
        let owner = state.pins.get(&pin).ok_or(EBADF)?.1;
        if owner != Owner::Group && owner != Owner::Member(self.id) {
            return Err(EBADF);
        }
        drop_pin(&mut state, pin);
        state.unpinned += 1;
        sweep_regions(&mut state);
        Ok(())
    }
}

/// A host that kills its guest at the (n+1)th call: the guest performs no further store.
struct Dying<'a> {
    host: &'a Guest,
    left: Cell<u32>,
}

impl Dying<'_> {
    fn tick(&self) {
        if self.left.get() == 0 {
            panic!("guest killed");
        }
        self.left.set(self.left.get() - 1);
    }
}

impl Host for Dying<'_> {
    fn create(&self, len: u32) -> Result<(u32, u32), i32> {
        self.tick();
        self.host.create(len)
    }
    fn attach(&self, handle: u32) -> Result<u32, i32> {
        self.tick();
        self.host.attach(handle)
    }
    fn detach(&self, handle: u32) -> Result<(), i32> {
        self.tick();
        self.host.detach(handle)
    }
    fn pin(&self, handle: u32) -> Result<u32, i32> {
        self.tick();
        self.host.pin(handle)
    }
    fn route_group(&self, pin: u32) -> Result<(), i32> {
        self.tick();
        self.host.route_group(pin)
    }
    fn unpin(&self, pin: u32) -> Result<(), i32> {
        self.tick();
        self.host.unpin(pin)
    }
}

struct Peer {
    guest: Guest,
    tag: u32,
    ledger: u32,
}

impl Peer {
    fn root(group: &Arc<Group>) -> Peer {
        let guest = group.join();
        let tag = create_tag(&guest).unwrap();
        let ledger = create_ledger(&group.mem, &guest).unwrap();
        Peer { guest, tag, ledger }
    }
    fn child(&self) -> Peer {
        let guest = self.guest.group.join();
        let tag = create_tag(&guest).unwrap();
        assert!(valid_ledger(&guest.group.mem, self.ledger));
        Peer {
            guest,
            tag,
            ledger: self.ledger,
        }
    }
    fn lanes(&self) -> Lanes<'_, Buffer, Guest> {
        Lanes {
            mem: &self.guest.group.mem,
            host: &self.guest,
            ledger: self.ledger,
            tag: self.tag,
        }
    }
    fn release(&self) {
        self.guest.group.release(self.guest.id);
    }
}

fn frame(index: usize, len: usize) -> Vec<u8> {
    let mut bytes = format!("{index}:").into_bytes();
    bytes.resize(len.max(bytes.len()), b'a' + (index % 26) as u8);
    bytes
}

fn post(lanes: &Lanes<'_, impl Memory, impl Host>, lane: LaneRef, side: u32, text: &[u8]) -> bool {
    let staged = lanes.reserve(lane, side, text).unwrap();
    lanes.commit(staged)
}

fn take(lanes: &Lanes<'_, impl Memory, impl Host>, lane: LaneRef, side: u32) -> Vec<Vec<u8>> {
    lanes.drain(lane, side, 1024).unwrap().frames
}

fn phases(peer: &Peer) -> BTreeMap<u32, usize> {
    let lanes = peer.lanes();
    let mut count = BTreeMap::new();
    for at in lanes.slots(true).chain(lanes.slots(false)) {
        *count.entry(lanes.mem.get(at + CLAIM).kind).or_default() += 1;
    }
    count
}

/// Nothing is claimed, staged, live or being cleaned; only pooled storage remains.
fn assert_settled(peer: &Peer) {
    let count = phases(peer);
    let busy: usize = count
        .iter()
        .filter(|(kind, _)| ![phase::FREE, phase::RELEASED].contains(kind))
        .map(|item| item.1)
        .sum();
    assert_eq!(busy, 0, "phases {count:?}");
    let pooled = count.get(&phase::RELEASED).copied().unwrap_or(0);
    let (_, pins) = peer.guest.group.counts();
    assert_eq!(
        pins,
        1 + pooled,
        "only the ledger and pooled slots stay pinned"
    );
    assert!(peer.lanes().mem.load(peer.ledger + H_POOL) <= POOL_LIMIT);
}

#[test]
fn claim_words_pack_tag_count_and_kind_together() {
    let word = Word::new(0xdead_beef, MAX_COUNT, phase::CLEANING);
    assert_eq!(Word::unpack(word.pack()), word);
    assert_eq!(Word::unpack(Word::new(7, 0, 0).pack()).tag, 7);
}

#[test]
fn inline_frames_arrive_in_order_in_both_directions() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    post(&lanes, lane, 0, b"one");
    post(&lanes, lane, 0, b"two");
    post(&lanes, lane, 1, b"back");
    assert_eq!(take(&lanes, lane, 1), [b"one".to_vec(), b"two".to_vec()]);
    assert_eq!(take(&lanes, lane, 0), [b"back".to_vec()]);
    assert!(take(&lanes, lane, 1).is_empty());
}

#[test]
fn cursors_wrap_the_non_power_of_two_period_continuously() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    let mut sent = 0;
    let mut got = Vec::new();
    // Far beyond 2 * RING bytes, with record sizes that straddle the physical end.
    for round in 0..400 {
        for _ in 0..7 {
            post(&lanes, lane, 0, &frame(sent, 300 + (sent * 37) % 4000));
            sent += 1;
        }
        got.extend(take(&lanes, lane, 1));
        assert_eq!(got.len(), sent, "round {round}");
    }
    for (index, bytes) in got.iter().enumerate() {
        assert_eq!(*bytes, frame(index, 300 + (index * 37) % 4000));
    }
    let base = lanes.mem.load(lanes.lane_slot(lane.slot) + ADDRESS) + D_BASE + D_STRIDE;
    assert!(lanes.mem.load(base + D_WRITE) < PERIOD);
}

#[test]
fn a_flood_spills_into_chained_segments_and_reuses_them_without_host_calls() {
    let group = Group::new(256);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    // About 70-byte frames, as in the flood fixture, far past one ring.
    for index in 0..5000 {
        post(&lanes, lane, 0, &frame(index, 70));
    }
    let mut got = Vec::new();
    loop {
        let drain = lanes.drain(lane, 1, 1024).unwrap();
        got.extend(drain.frames);
        if !drain.more {
            break;
        }
    }
    assert_eq!(got.len(), 5000);
    assert!(
        got.iter()
            .enumerate()
            .all(|(index, bytes)| *bytes == frame(index, 70))
    );
    // Seal and pass the chain's tail, so every segment is back in the pool.
    post(&lanes, lane, 0, b"seal");
    assert_eq!(take(&lanes, lane, 1).len(), 1);
    let calls = group.calls();
    for index in 0..5000 {
        post(&lanes, lane, 0, &frame(index, 70));
    }
    while lanes.drain(lane, 1, 1024).unwrap().more {}
    assert_eq!(
        group.calls(),
        calls,
        "the second flood reused released segments"
    );
}

#[test]
fn large_frames_spill_whole() {
    let group = Group::new(256);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    // The 197,589-byte task and a 2 MiB ArrayBuffer encoded as base64 JSON (about 2.67 MiB).
    let sizes = [818, 197_589, 2_796_300, 818];
    for (index, len) in sizes.iter().enumerate() {
        post(&lanes, lane, 0, &frame(index, *len));
    }
    let got = take(&lanes, lane, 1);
    assert_eq!(got.len(), 4);
    for (index, len) in sizes.iter().enumerate() {
        assert_eq!(got[index], frame(index, *len));
    }
}

#[test]
fn frames_above_64_mib_are_refused_before_anything_is_staged() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    let calls = group.calls();
    let big = vec![b'x'; MAX_FRAME as usize + 1];
    assert_eq!(lanes.reserve(lane, 0, &big), Err(Refusal::TooLarge));
    assert_eq!(group.calls(), calls);
    assert_eq!(lanes.mem.load(lanes.dir_at(lane.slot, 1) + WRITING), 0);
}

/// Builds a lane where the next post of `text` stages as `expect`.
fn scenario(kind: &str) -> (Arc<Group>, Peer, LaneRef, Vec<Vec<u8>>, Vec<u8>) {
    let group = Group::new(128);
    let root = Peer::root(&group);
    let lane = root.lanes().create_lane().unwrap();
    let lanes = root.lanes();
    let mut sent = Vec::new();
    let mut send = |bytes: Vec<u8>| {
        post(&lanes, lane, 0, &bytes);
        sent.push(bytes);
    };
    let next = match kind {
        "inline" => {
            send(frame(0, 100));
            frame(1, 100)
        }
        "first-spill" => {
            send(frame(0, 100));
            frame(1, 20_000)
        }
        "append" => {
            send(frame(0, 20_000));
            frame(1, 100)
        }
        "link" => {
            send(frame(0, 30_000));
            send(frame(1, 30_000));
            frame(2, 30_000)
        }
        _ => {
            send(frame(0, 20_000));
            frame(1, 100)
        }
    };
    (group, root, lane, sent, next)
}

#[test]
fn every_commit_store_leaves_the_frame_either_absent_or_whole() {
    for kind in ["inline", "first-spill", "append", "link", "return-to-ring"] {
        let probe = scenario(kind);
        let ops = {
            let lanes = probe.1.lanes();
            if kind == "return-to-ring" {
                assert_eq!(take(&lanes, probe.2, 1), probe.3);
            }
            let staged = lanes.reserve(probe.2, 0, &probe.4).unwrap();
            let expected = match staged {
                Staged::Inline { .. } => "inline",
                Staged::FirstSpill { .. } => "first-spill",
                Staged::Append { .. } => "append",
                Staged::Link { .. } => "link",
                Staged::ReturnToRing { .. } => "return-to-ring",
                Staged::Discard => "discard",
            };
            assert_eq!(expected, kind);
            lanes.abort(staged);
            lanes
                .commit_ops(lanes.reserve(probe.2, 0, &probe.4).unwrap())
                .len()
        };
        for split in 0..=ops {
            let (_group, root, lane, mut before, next) = scenario(kind);
            let lanes = root.lanes();
            if kind == "return-to-ring" {
                assert_eq!(take(&lanes, lane, 1), before);
                before.clear();
            }
            let staged = lanes.reserve(lane, 0, &next).unwrap();
            let steps = lanes.commit_ops(staged);
            for op in &steps[..split] {
                lanes.apply(*op);
            }
            let mut got = take(&lanes, lane, 1);
            let published = got.len() > before.len();
            for op in &steps[split..] {
                lanes.apply(*op);
            }
            got.extend(take(&lanes, lane, 1));
            let mut want = before.clone();
            want.push(next.clone());
            assert_eq!(
                got, want,
                "{kind}, split {split} of {ops}, seen early: {published}"
            );
        }
    }
}

#[test]
fn an_aborted_spill_is_invisible_and_its_segment_is_pooled() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    let staged = lanes.reserve(lane, 0, &frame(0, 50_000)).unwrap();
    assert!(matches!(staged, Staged::FirstSpill { .. }));
    lanes.abort(staged);
    lanes.abort(staged);
    assert!(take(&lanes, lane, 1).is_empty());
    assert_eq!(phases(&root).get(&phase::RELEASED), Some(&1));
    let calls = group.calls();
    post(&lanes, lane, 0, &frame(1, 50_000));
    assert_eq!(group.calls(), calls);
    assert_eq!(take(&lanes, lane, 1), [frame(1, 50_000)]);
}

#[test]
fn a_refused_region_leaves_the_ledger_and_lane_unchanged() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    let lane = lanes.create_lane().unwrap();
    post(&lanes, lane, 0, b"before");
    for (op, errno) in [("create", ENOMEM), ("pin", EAGAIN), ("route_group", EAGAIN)] {
        let counts = group.counts();
        group.fail_next(op, errno);
        assert_eq!(
            lanes.reserve(lane, 0, &frame(0, 40_000)),
            Err(Refusal::Host(errno)),
            "{op}"
        );
        assert_eq!(group.counts(), counts, "{op}");
        assert_eq!(lanes.mem.load(lanes.dir_at(lane.slot, 1) + WRITING), 0);
    }
    group.fail_next("create", ENOMEM);
    assert_eq!(lanes.create_lane(), Err(Refusal::Host(ENOMEM)));
    assert_eq!(phases(&root).get(&phase::LIVE), Some(&1));
    assert_eq!(take(&lanes, lane, 1), [b"before".to_vec()]);
}

#[test]
fn a_full_ledger_refuses() {
    let group = Group::new(1200);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    for _ in 0..LANE_SLOTS {
        lanes.create_lane().unwrap();
    }
    assert_eq!(lanes.create_lane(), Err(Refusal::Ledger));
}

#[test]
fn a_closed_reader_discards_and_the_fence_releases_once_either_way() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let lanes = root.lanes();
    // Closer first: the writer sees reader-closed and discards.
    let lane = lanes.create_lane().unwrap();
    post(&lanes, lane, 0, &frame(0, 30_000));
    lanes.close_read(lane, 1);
    assert_eq!(lanes.reserve(lane, 0, b"late"), Ok(Staged::Discard));
    assert!(lanes.peer_closed(lane, 0));
    assert_eq!(
        phases(&root).get(&phase::LIVE),
        Some(&1),
        "the segment left with the reader"
    );
    // Writer inside a reservation: the closer leaves the segments to it.
    let lane = lanes.create_lane().unwrap();
    post(&lanes, lane, 0, &frame(0, 30_000));
    let staged = lanes.reserve(lane, 0, &frame(1, 100)).unwrap();
    lanes.close_read(lane, 1);
    assert_eq!(phases(&root).get(&phase::LIVE), Some(&3));
    lanes.commit(staged);
    assert_eq!(phases(&root).get(&phase::LIVE), Some(&2));
}

#[test]
fn a_moved_writer_continues_the_chain_from_shared_words() {
    let group = Group::new(128);
    let root = Peer::root(&group);
    let other = root.child();
    let (a, b) = (root.lanes(), other.lanes());
    let lane = a.create_lane().unwrap();
    post(&a, lane, 0, &frame(0, 30_000));
    post(&a, lane, 0, &frame(1, 100));
    let epoch = a.transfer_epoch(lane, 0).unwrap();
    a.transfer(lane, 0, Custody::Tag(root.tag));
    assert_eq!(a.reserve(lane, 0, b"x"), Err(Refusal::NotOwned));
    assert!(b.adopt(lane, 0, epoch, 1));
    assert!(!b.adopt(lane, 0, epoch, 1), "an end is adopted once");
    post(&b, lane, 0, &frame(2, 100));
    post(&b, lane, 0, &frame(3, 40_000));
    let got = take(&a, lane, 1);
    assert_eq!(
        got,
        [
            frame(0, 30_000),
            frame(1, 100),
            frame(2, 100),
            frame(3, 40_000)
        ]
    );
    // The reader moves too and continues where the old one stopped.
    post(&b, lane, 0, &frame(4, 20_000));
    let epoch = a.transfer_epoch(lane, 1).unwrap();
    a.transfer(lane, 1, Custody::Tag(root.tag));
    assert!(b.adopt(lane, 1, epoch, 1));
    post(&b, lane, 0, &frame(5, 10));
    assert_eq!(take(&b, lane, 1), [frame(4, 20_000), frame(5, 10)]);
}

#[test]
fn adoption_and_the_cascade_have_exactly_one_winner() {
    for adopt_first in [true, false] {
        let group = Group::new(64);
        let root = Peer::root(&group);
        let other = root.child();
        let (a, b) = (root.lanes(), other.lanes());
        let carrier = a.create_lane().unwrap();
        let carried = a.create_lane().unwrap();
        let epoch = a.transfer_epoch(carried, 1).unwrap();
        a.transfer(carried, 1, Custody::Lane(carrier, 1));
        if adopt_first {
            assert!(b.adopt(carried, 1, epoch, 1));
            a.close_read(carrier, 1);
            assert_eq!(a.end_state(carried, 1).0, end::OPEN);
        } else {
            a.close_read(carrier, 1);
            assert!(!b.adopt(carried, 1, epoch, 1));
            assert_eq!(a.end_state(carried, 1).0, end::CLOSED);
            assert!(
                a.drain(carried, 0, 8).unwrap().terminal,
                "the peer sees the end go"
            );
        }
    }
}

#[test]
fn a_transfer_toward_an_already_closed_direction_closes_itself() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let a = root.lanes();
    let carrier = a.create_lane().unwrap();
    let carried = a.create_lane().unwrap();
    a.close_read(carrier, 1);
    a.transfer(carried, 1, Custody::Lane(carrier, 1));
    assert_eq!(a.end_state(carried, 1).0, end::CLOSED);
}

#[test]
fn a_sender_released_before_the_receiver_decodes_loses_nothing() {
    let group = Group::new(128);
    let root = Peer::root(&group);
    let sender = root.child();
    let receiver = root.child();
    let (r, s, d) = (root.lanes(), sender.lanes(), receiver.lanes());
    // The carrier runs sender -> receiver; the carried lane's peer stays in the root.
    let carrier = r.create_lane().unwrap();
    let carried = r.create_lane().unwrap();
    for (side, peer) in [(0, &s), (1, &d)] {
        let epoch = r.transfer_epoch(carrier, side).unwrap();
        r.transfer(carrier, side, Custody::Tag(root.tag));
        assert!(peer.adopt(carrier, side, epoch, 1));
    }
    let epoch = r.transfer_epoch(carried, 1).unwrap();
    r.transfer(carried, 1, Custody::Tag(root.tag));
    assert!(s.adopt(carried, 1, epoch, 1));
    let epoch = s.transfer_epoch(carried, 1).unwrap();
    s.transfer(carried, 1, Custody::Lane(carrier, 1));
    post(&s, carrier, 0, &frame(epoch as usize, 300_000));
    sender.release();
    r.sweep(true);
    let got = take(&d, carrier, 1);
    assert_eq!(got, [frame(epoch as usize, 300_000)]);
    assert!(d.adopt(carried, 1, epoch, 2));
    post(&d, carried, 1, b"from the adopter");
    assert_eq!(take(&r, carried, 0), [b"from the adopter".to_vec()]);
}

#[test]
fn a_receiver_released_before_decoding_closes_the_carried_end() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let receiver = root.child();
    let (r, d) = (root.lanes(), receiver.lanes());
    let carrier = r.create_lane().unwrap();
    let carried = r.create_lane().unwrap();
    let epoch = r.transfer_epoch(carrier, 1).unwrap();
    r.transfer(carrier, 1, Custody::Tag(root.tag));
    assert!(d.adopt(carrier, 1, epoch, 1));
    r.transfer(carried, 1, Custody::Lane(carrier, 1));
    post(&r, carrier, 0, b"carries a port");
    receiver.release();
    let guard = Guarded {
        inner: &group.mem,
        forbidden: lane_regions(&r, &[carrier, carried]),
    };
    Lanes {
        mem: &guard,
        host: &root.guest,
        ledger: root.ledger,
        tag: root.tag,
    }
    .sweep(true);
    assert_eq!(r.end_state(carried, 1).0, end::CLOSED);
    assert!(r.drain(carried, 0, 8).unwrap().terminal);
    assert!(r.peer_closed(carrier, 0));
}

fn lane_regions(lanes: &Lanes<'_, Buffer, Guest>, list: &[LaneRef]) -> Vec<(u32, u32)> {
    list.iter()
        .map(|lane| {
            (
                lanes.mem.load(lanes.lane_slot(lane.slot) + ADDRESS),
                LANE_BYTES,
            )
        })
        .collect()
}

#[test]
fn an_exit_report_waits_for_the_host_release_before_storage_is_reused() {
    let group = Group::new(128);
    let root = Peer::root(&group);
    let r = root.lanes();
    let cell = r.create_cell().unwrap();
    let child = root.child();
    let c = child.lanes();
    assert!(c.register(cell));
    let lane = r.create_lane().unwrap();
    let epoch = r.transfer_epoch(lane, 1).unwrap();
    r.transfer(lane, 1, Custody::Cell(cell));
    assert!(c.adopt(lane, 1, epoch, 1));
    post(&r, lane, 0, &frame(0, 30_000));
    post(&c, lane, 1, &frame(1, 30_000));
    // The child is reported exited but the host has not released it.
    r.exited(cell);
    r.sweep(true);
    assert_eq!(r.end_state(lane, 1).0, end::CLOSED_DEAD);
    assert!(r.peer_closed(lane, 0), "the parent stops writing to it");
    assert_eq!(
        phases(&root).get(&phase::LIVE),
        Some(&3),
        "nothing the child can touch is freed"
    );
    // The parent still reads everything the child committed.
    let drain = r.drain(lane, 0, 8).unwrap();
    assert_eq!(drain.frames, [frame(1, 30_000)]);
    assert!(drain.terminal);
    child.release();
    r.sweep(false);
    assert_eq!(r.end_state(lane, 1).0, end::CLOSED);
    assert_eq!(r.mem.load(root.ledger + H_AWAITING), 0);
    r.close_end(lane, 0);
    r.sweep(false);
    assert_settled(&root);
}

#[test]
fn a_retained_member_keeps_its_storage() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let cell = r.create_cell().unwrap();
    let child = root.child();
    assert!(child.lanes().register(cell));
    let lane = r.create_lane().unwrap();
    let epoch = r.transfer_epoch(lane, 1).unwrap();
    r.transfer(lane, 1, Custody::Cell(cell));
    assert!(child.lanes().adopt(lane, 1, epoch, 1));
    r.exited(cell);
    r.close_end(lane, 0);
    for _ in 0..3 {
        r.sweep(true);
    }
    assert_eq!(r.end_state(lane, 1).0, end::CLOSED_DEAD);
    assert_eq!(phases(&root).get(&phase::LIVE), Some(&1));
}

#[test]
fn worker_data_ports_close_when_the_child_never_starts() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let cell = r.create_cell().unwrap();
    let lane = r.create_lane().unwrap();
    let epoch = r.transfer_epoch(lane, 1).unwrap();
    r.transfer(lane, 1, Custody::Cell(cell));
    r.exited(cell);
    assert_eq!(r.end_state(lane, 1).0, end::CLOSED);
    let late = root.child();
    assert!(!late.lanes().register(cell));
    assert!(!late.lanes().adopt(lane, 1, epoch, 1));
}

#[test]
fn a_creator_killed_at_any_host_step_leaves_nothing_behind() {
    for steps in 0..=4 {
        let group = Group::new(64);
        let root = Peer::root(&group);
        let worker = root.child();
        let dying = Dying {
            host: &worker.guest,
            left: Cell::new(steps),
        };
        let lanes = Lanes {
            mem: &group.mem,
            host: &dying,
            ledger: root.ledger,
            tag: worker.tag,
        };
        let _ = catch_unwind(AssertUnwindSafe(|| lanes.create_lane()));
        worker.release();
        root.lanes().sweep(true);
        assert_settled(&root);
    }
    for steps in 0..=4 {
        let group = Group::new(64);
        let root = Peer::root(&group);
        let lane = root.lanes().create_lane().unwrap();
        let worker = root.child();
        let epoch = root.lanes().transfer_epoch(lane, 0).unwrap();
        root.lanes().transfer(lane, 0, Custody::Tag(root.tag));
        assert!(worker.lanes().adopt(lane, 0, epoch, 1));
        let dying = Dying {
            host: &worker.guest,
            left: Cell::new(steps),
        };
        let lanes = Lanes {
            mem: &group.mem,
            host: &dying,
            ledger: root.ledger,
            tag: worker.tag,
        };
        let _ = catch_unwind(AssertUnwindSafe(|| {
            lanes.reserve(lane, 0, &frame(0, 40_000))
        }));
        worker.release();
        root.lanes().sweep(true);
        root.lanes().close_end(lane, 1);
        assert_settled(&root);
    }
}

#[test]
fn a_cleaner_killed_before_unpin_is_recovered_once() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    post(&r, lane, 0, &frame(0, 2_000_000));
    assert_eq!(take(&r, lane, 1).len(), 1);
    // The reader caught up, so this returns to the ring and seals the segment.
    post(&r, lane, 0, b"seal");
    assert_eq!(take(&r, lane, 1).len(), 1);
    let cleaner = root.child();
    let dying = Dying {
        host: &cleaner.guest,
        left: Cell::new(0),
    };
    let lanes = Lanes {
        mem: &group.mem,
        host: &dying,
        ledger: root.ledger,
        tag: cleaner.tag,
    };
    let _ = catch_unwind(AssertUnwindSafe(|| lanes.sweep(false)));
    assert_eq!(
        phases(&root).get(&phase::CLEANING),
        Some(&1),
        "the cleaner kept the slot exclusive"
    );
    r.sweep(true);
    assert_eq!(
        phases(&root).get(&phase::CLEANING),
        Some(&1),
        "a live cleaner is not overtaken"
    );
    cleaner.release();
    let unpinned = group.state.lock().unwrap().unpinned;
    r.sweep(true);
    assert_eq!(group.state.lock().unwrap().unpinned, unpinned + 1);
    r.sweep(true);
    assert_eq!(group.state.lock().unwrap().unpinned, unpinned + 1);
    r.close_end(lane, 0);
    r.close_end(lane, 1);
    assert_settled(&root);
}

#[test]
fn group_pinned_lanes_and_ledger_survive_the_first_member() {
    let group = Group::new(256);
    let root = Peer::root(&group);
    let (a, b) = (root.child(), root.child());
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    for (side, peer) in [(0, &a), (1, &b)] {
        let epoch = r.transfer_epoch(lane, side).unwrap();
        r.transfer(lane, side, Custody::Tag(root.tag));
        assert!(peer.lanes().adopt(lane, side, epoch, 1));
    }
    root.release();
    let lane_at = r.mem.load(r.lane_slot(lane.slot) + ADDRESS);
    let third = Peer {
        guest: group.join(),
        tag: 0,
        ledger: root.ledger,
    };
    for index in 0..50 {
        post(&a.lanes(), lane, 0, &frame(index, 90_000));
        let (handle, address) = third.guest.create(PAGE * 4).unwrap();
        assert!(address + 4 * PAGE <= root.ledger || address >= root.ledger + LEDGER_BYTES);
        assert!(address + 4 * PAGE <= lane_at || address >= lane_at + LANE_BYTES);
        third.guest.detach(handle).unwrap();
        assert_eq!(take(&b.lanes(), lane, 1), [frame(index, 90_000)]);
    }
    third.release();
    a.release();
    b.release();
    assert_eq!(
        group.counts(),
        (0, 0),
        "the group's end drops every group pin"
    );
    assert!(group.regions().is_empty());
}

#[test]
fn two_sweepers_unpin_each_slot_once() {
    let group = Group::new(256);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    for index in 0..6 {
        post(&r, lane, 0, &frame(index, 1_500_000));
    }
    assert_eq!(take(&r, lane, 1).len(), 6);
    post(&r, lane, 0, b"seal");
    assert_eq!(take(&r, lane, 1).len(), 1);
    let other = root.child();
    let unpinned = group.state.lock().unwrap().unpinned;
    std::thread::scope(|scope| {
        scope.spawn(|| root.lanes().sweep(true));
        scope.spawn(|| other.lanes().sweep(true));
    });
    let after = group.state.lock().unwrap().unpinned;
    assert_eq!(after - unpinned, 6, "every slot above the pool limit, once");
    r.close_end(lane, 0);
    r.close_end(lane, 1);
    assert_settled(&root);
}

#[test]
fn the_drain_quota_reports_more_and_never_a_false_empty() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    for index in 0..1500 {
        post(&r, lane, 0, &frame(index, 20));
    }
    let first = r.drain(lane, 1, 1024).unwrap();
    assert_eq!(
        (first.frames.len(), first.more, first.terminal),
        (1024, true, false)
    );
    assert_eq!(
        r.mem.load(r.dir_at(lane.slot, 1) + ARMED),
        0,
        "a quota exit is not armed"
    );
    r.close_end(lane, 0);
    let second = r.drain(lane, 1, 1024).unwrap();
    assert_eq!(
        (second.frames.len(), second.more, second.terminal),
        (476, false, true)
    );
}

#[test]
fn arming_and_commit_cannot_both_miss() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    // Commit before the reader arms: the drain finds it, no hint.
    assert!(!post(&r, lane, 0, b"early"));
    assert_eq!(take(&r, lane, 1).len(), 1);
    // The reader armed on empty: the next commit's swap sees it.
    assert!(post(&r, lane, 0, b"after"));
    assert!(!post(&r, lane, 0, b"again"), "one hint per idle period");
    assert_eq!(take(&r, lane, 1).len(), 2);
    // Commit between arming and the recheck: the recheck finds it and a spare hint is sent.
    let staged = r.reserve(lane, 0, b"between").unwrap();
    r.mem.put(r.dir_at(lane.slot, 1) + ARMED, lane.generation);
    assert!(r.commit(staged));
    assert_eq!(take(&r, lane, 1), [b"between".to_vec()]);
    // A close wakes an armed reader, and the lane says terminal.
    assert!(r.close_end(lane, 0));
    assert!(r.drain(lane, 1, 8).unwrap().terminal);
}

#[test]
fn a_final_unsealed_tail_is_released_once_its_writer_is_closed() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let other = root.child();
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    let epoch = r.transfer_epoch(lane, 0).unwrap();
    r.transfer(lane, 0, Custody::Tag(root.tag));
    assert!(other.lanes().adopt(lane, 0, epoch, 1));
    post(&other.lanes(), lane, 0, &frame(0, 50_000));
    assert_eq!(take(&r, lane, 1), [frame(0, 50_000)]);
    assert_eq!(
        phases(&root).get(&phase::LIVE),
        Some(&2),
        "an open writer may append"
    );
    other.lanes().close_end(lane, 0);
    let drain = r.drain(lane, 1, 8).unwrap();
    assert!(drain.frames.is_empty() && drain.terminal);
    assert_eq!(phases(&root).get(&phase::LIVE), Some(&1));
}

#[test]
fn a_corrupt_cursor_closes_the_direction_and_throws() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    post(&r, lane, 0, b"fine");
    let block = r.mem.load(r.lane_slot(lane.slot) + ADDRESS) + D_BASE + D_STRIDE;
    r.mem.put(block + D_WRITE, PERIOD + 4);
    assert!(matches!(r.drain(lane, 1, 8), Err(Refusal::Corrupt(_))));
    assert!(r.peer_closed(lane, 0));
    r.mem.put(r.lane_slot(lane.slot) + ADDRESS, 3);
    assert!(matches!(r.drain(lane, 1, 8), Err(Refusal::Corrupt(_))));
}

#[test]
fn inbound_references_are_checked_before_any_access() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    assert!(!r.adopt(
        LaneRef {
            slot: LANE_SLOTS,
            generation: 1
        },
        0,
        1,
        0
    ));
    assert!(!r.adopt(lane, 2, 1, 0));
    assert!(!r.adopt(
        LaneRef {
            slot: lane.slot,
            generation: lane.generation + 1
        },
        0,
        1,
        0
    ));
    assert!(!r.register(CellRef {
        index: SMALL_SLOTS,
        generation: 1
    }));
    assert_eq!(
        r.drain(
            LaneRef {
                slot: 9,
                generation: 1
            },
            1,
            1
        ),
        Err(Refusal::NotOwned)
    );
    assert!(!valid_ledger(&group.mem, 0));
    assert!(!valid_ledger(&group.mem, root.ledger + 4));
}

#[test]
fn generations_and_epochs_refuse_before_they_wrap() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    for slot in 0..LANE_SLOTS {
        r.mem.set(
            r.lane_slot(slot) + CLAIM,
            Word::new(0, MAX_COUNT, phase::FREE),
        );
    }
    assert_eq!(r.create_lane(), Err(Refusal::Ledger));
    r.mem
        .set(r.lane_slot(3) + CLAIM, Word::new(0, 5, phase::FREE));
    let lane = r.create_lane().unwrap();
    assert_eq!(
        lane,
        LaneRef {
            slot: 3,
            generation: 6
        }
    );
    let at = r.end_at(3, 0);
    r.mem.set(at, Word::new(root.tag, MAX_COUNT - 1, end::OPEN));
    assert_eq!(r.transfer_epoch(lane, 0), Err(Refusal::Exhausted));
}

#[test]
fn a_writer_and_reader_on_two_threads_agree_on_every_frame() {
    let group = Group::new(512);
    let root = Peer::root(&group);
    let other = root.child();
    let lane = root.lanes().create_lane().unwrap();
    let epoch = root.lanes().transfer_epoch(lane, 1).unwrap();
    root.lanes().transfer(lane, 1, Custody::Tag(root.tag));
    assert!(other.lanes().adopt(lane, 1, epoch, 1));
    let size = |index: usize| match index % 97 {
        0 => 120_000,
        1..=5 => 20_000,
        _ => 10 + index % 300,
    };
    const COUNT: usize = 6000;
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let lanes = root.lanes();
            for index in 0..COUNT {
                loop {
                    match lanes.reserve(lane, 0, &frame(index, size(index))) {
                        Ok(staged) => {
                            lanes.commit(staged);
                            break;
                        }
                        Err(Refusal::Host(_) | Refusal::Ledger) => std::thread::yield_now(),
                        Err(error) => panic!("{error}"),
                    }
                }
            }
            lanes.close_end(lane, 0);
        });
        scope.spawn(|| {
            let lanes = other.lanes();
            let mut next = 0;
            loop {
                let drain = lanes.drain(lane, 1, 64).unwrap();
                for bytes in drain.frames {
                    assert_eq!(bytes, frame(next, size(next)), "frame {next}");
                    next += 1;
                }
                if drain.terminal {
                    break;
                }
                std::thread::yield_now();
            }
            assert_eq!(next, COUNT);
            lanes.close_end(lane, 1);
        });
    });
    root.lanes().sweep(true);
    assert_settled(&root);
}
