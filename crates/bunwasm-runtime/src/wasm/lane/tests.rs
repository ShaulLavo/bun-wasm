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
    r.sweep(Sweep::Full);
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
    .sweep(Sweep::Full);
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
    assert!(r.sweep(Sweep::Full), "the dead end still awaits release");
    assert_eq!(r.end_state(lane, 1).0, end::CLOSED_DEAD);
    assert_eq!(r.census().awaiting, 1);
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
    assert!(!r.sweep(Sweep::Dead), "nothing awaits release any more");
    assert_eq!(r.end_state(lane, 1).0, end::CLOSED);
    assert_eq!(r.census().awaiting, 0);
    r.close_end(lane, 0);
    r.sweep(Sweep::Trim);
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
        r.sweep(Sweep::Full);
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
        root.lanes().sweep(Sweep::Full);
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
        root.lanes().sweep(Sweep::Full);
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
    let _ = catch_unwind(AssertUnwindSafe(|| lanes.sweep(Sweep::Trim)));
    assert_eq!(
        phases(&root).get(&phase::CLEANING),
        Some(&1),
        "the cleaner kept the slot exclusive"
    );
    r.sweep(Sweep::Full);
    assert_eq!(
        phases(&root).get(&phase::CLEANING),
        Some(&1),
        "a live cleaner is not overtaken"
    );
    cleaner.release();
    let unpinned = group.state.lock().unwrap().unpinned;
    r.sweep(Sweep::Full);
    assert_eq!(group.state.lock().unwrap().unpinned, unpinned + 1);
    r.sweep(Sweep::Full);
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
        scope.spawn(|| root.lanes().sweep(Sweep::Full));
        scope.spawn(|| other.lanes().sweep(Sweep::Full));
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
    // The failure is reported once. The reader has stopped for good, so every later read says
    // the lane is over, without looking at the lane again.
    r.mem.put(r.lane_slot(lane.slot) + ADDRESS, 3);
    let after = r.drain(lane, 1, 8).unwrap();
    assert!(after.terminal && after.frames.is_empty() && !after.more);
    assert_eq!(r.drain(lane, 1, 8).unwrap(), after);
    // A lane whose address fails validation closes the same way, with no access through it.
    let other = r.create_lane().unwrap();
    r.mem.put(r.lane_slot(other.slot) + ADDRESS, 3);
    assert!(matches!(r.drain(other, 1, 8), Err(Refusal::Corrupt(_))));
    assert!(r.peer_closed(other, 0));
    assert!(r.drain(other, 1, 8).unwrap().terminal);
    // An end this member does not own is refused every time: that is not a lane failure.
    assert_eq!(r.drain(lane, 2, 8), Err(Refusal::NotOwned));
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
    root.lanes().sweep(Sweep::Full);
    assert_settled(&root);
}

#[test]
fn a_severed_writer_is_terminal_for_its_peer_and_deaths_are_counted() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    post(&r, lane, 0, b"before the sever");
    r.sever(lane, 0);
    let drain = r.drain(lane, 1, 8).unwrap();
    assert_eq!(drain.frames, [b"before the sever".to_vec()]);
    assert!(drain.terminal, "the orphan's peer stops waiting");
    assert_eq!(
        r.end_state(lane, 0).0,
        end::OPEN,
        "the orphan's own end is left alone"
    );
    let deaths = r.deaths();
    let cell = r.create_cell().unwrap();
    r.exited(cell);
    assert_eq!(r.deaths(), deaths + 1);
}

#[test]
fn the_census_names_every_pin_the_lanes_keep() {
    let group = Group::new(128);
    let root = Peer::root(&group);
    let r = root.lanes();
    assert_eq!(
        r.census(),
        Census {
            pins: 1,
            ..Census::default()
        }
    );
    let lane = r.create_lane().unwrap();
    post(&r, lane, 0, &frame(0, 50_000));
    let cell = r.create_cell().unwrap();
    let census = r.census();
    assert_eq!(
        (
            census.live_lanes,
            census.open_ends,
            census.linked_segments,
            census.cells
        ),
        (1, 2, 1, 1)
    );
    assert_eq!(
        census.pins as usize,
        group.counts().1,
        "every host pin is a ledger pin"
    );
    r.exited(cell);
    r.close_end(lane, 0);
    r.close_end(lane, 1);
    r.sweep(Sweep::Trim);
    let census = r.census();
    assert_eq!(
        (
            census.live_lanes,
            census.linked_segments,
            census.busy,
            census.cells
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(census.pooled, 2);
    assert_eq!(census.pins as usize, group.counts().1);
}

/// Memory for one finalizer that parks before its `stop`th access until released, so a test can
/// run other guests at that exact point and then let the finalizer finish.
struct Parking<'a> {
    inner: &'a Buffer,
    stop: usize,
    seen: std::sync::atomic::AtomicUsize,
    state: Mutex<(bool, bool)>,
    changed: std::sync::Condvar,
}

impl<'a> Parking<'a> {
    fn new(inner: &'a Buffer, stop: usize) -> Parking<'a> {
        Parking {
            inner,
            stop,
            seen: std::sync::atomic::AtomicUsize::new(0),
            state: Mutex::new((false, false)),
            changed: std::sync::Condvar::new(),
        }
    }
    /// Blocks until the finalizer parked; false when it finished first.
    fn parked(&self, done: &std::sync::atomic::AtomicBool) -> bool {
        let mut state = self.state.lock().unwrap();
        while !state.0 && !done.load(SeqCst) {
            state = self
                .changed
                .wait_timeout(state, std::time::Duration::from_millis(1))
                .unwrap()
                .0;
        }
        state.0
    }
    fn resume(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

impl Memory for Parking<'_> {
    fn size(&self) -> u64 {
        self.inner.size()
    }
    fn raw(&self, at: u32, len: u32) -> *mut u8 {
        if self.seen.fetch_add(1, SeqCst) == self.stop {
            let mut state = self.state.lock().unwrap();
            state.0 = true;
            self.changed.notify_all();
            while !state.1 {
                state = self.changed.wait(state).unwrap();
            }
        }
        self.inner.raw(at, len)
    }
}

/// The new use of a reused lane slot is untouched by a finalizer of its earlier use.
fn assert_fresh_lane(other: &Peer, lane: LaneRef) {
    let o = other.lanes();
    for dir in 0..2 {
        let at = o.dir_at(lane.slot, dir);
        assert_eq!(
            o.mem.load(at + READER_CLOSED),
            0,
            "reader-closed of the new use"
        );
        assert_eq!(o.mem.load(at + WRITING), 0, "writer fence of the new use");
        assert_eq!(o.mem.get(o.end_at(lane.slot, dir)).kind, end::OPEN);
        assert!(!o.peer_closed(lane, dir));
    }
    post(&o, lane, 0, b"new use");
    assert_eq!(take(&o, lane, 1), [b"new use".to_vec()]);
    let census = o.census();
    assert_eq!(
        (census.awaiting, census.dead_ends, census.in_flight),
        (0, 0, 0)
    );
}

/// Runs `finalize` on its own thread parked before each of its accesses in turn. While it is
/// parked, `other` finishes the lane and reuses its slot. Then the finalizer resumes.
fn every_interleaving<T: Copy + Send + Sync>(
    setup: impl Fn(&Arc<Group>, &Peer) -> (LaneRef, T),
    finalize: impl Fn(&Lanes<'_, Parking<'_>, Guest>, T) + Sync,
) {
    /// Marks the finalizer finished however it ends, so the test never waits on a panic.
    struct Done<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            self.0.store(true, SeqCst);
        }
    }
    let mut overlaps = 0;
    for stop in 0.. {
        let group = Group::new(16);
        let root = Peer::root(&group);
        let other = root.child();
        let (lane, context) = setup(&group, &root);
        let parking = Parking::new(&group.mem, stop);
        let done = std::sync::atomic::AtomicBool::new(false);
        let finished = std::thread::scope(|scope| {
            scope.spawn(|| {
                let _done = Done(&done);
                let lanes = Lanes {
                    mem: &parking,
                    host: &root.guest,
                    ledger: root.ledger,
                    tag: root.tag,
                };
                finalize(&lanes, context);
            });
            let parked = parking.parked(&done);
            if parked {
                other.lanes().sweep(Sweep::Full);
                other.lanes().cascade();
            }
            let reused = parked.then(|| other.lanes().create_lane().unwrap());
            parking.resume();
            (parked, reused)
        });
        let (parked, reused) = finished;
        if !parked {
            assert!(
                overlaps > 0,
                "no stop of {stop} overlapped a reuse of the slot"
            );
            return;
        }
        let Some(reused) = reused else { continue };
        if reused.slot == lane.slot {
            overlaps += 1;
            assert_fresh_lane(&other, reused);
        }
    }
}

#[test]
fn a_death_declaration_racing_its_release_never_touches_the_reused_slot() {
    every_interleaving(
        |_, root| {
            let r = root.lanes();
            let cell = r.create_cell().unwrap();
            let worker = root.child();
            assert!(worker.lanes().register(cell));
            let lane = r.create_lane().unwrap();
            let epoch = r.transfer_epoch(lane, 1).unwrap();
            r.transfer(lane, 1, Custody::Cell(cell));
            assert!(worker.lanes().adopt(lane, 1, epoch, 1));
            post(&worker.lanes(), lane, 1, &frame(0, 30_000));
            r.close_end(lane, 0);
            // The finalizer is the parent's exit report. The other guest's sweep releases the
            // same end, because the host has already released the worker.
            worker.release();
            (lane, cell)
        },
        |lanes, cell| lanes.exited(cell),
    );
}

#[test]
fn two_finalizers_of_one_lane_never_touch_the_reused_slot() {
    every_interleaving(
        |group, root| {
            let r = root.lanes();
            let lane = r.create_lane().unwrap();
            let cell = r.create_cell().unwrap();
            r.transfer(lane, 1, Custody::Cell(cell));
            r.close_end(lane, 0);
            // The custody is gone but no cascade ran yet: both finalizers will try.
            let at = r.small_slot(cell.index);
            let claim = group.mem.get(at + CLAIM);
            group
                .mem
                .set(at + CLAIM, Word::new(0, claim.count, phase::FREE));
            (lane, ())
        },
        |lanes, ()| lanes.cascade(),
    );
}

#[test]
fn near_limit_epochs_close_without_wrapping_and_retire_the_slot() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    let at = r.end_at(lane.slot, 1);
    // An end two epochs too close to the limit cannot move at all.
    r.mem.set(at, Word::new(root.tag, MAX_COUNT - 3, end::OPEN));
    assert_eq!(r.transfer_epoch(lane, 1), Err(Refusal::Exhausted));
    // The last end that may move still has room to be adopted, declared dead and released.
    r.mem.set(at, Word::new(root.tag, MAX_COUNT - 4, end::OPEN));
    let cell = r.create_cell().unwrap();
    let worker = root.child();
    assert!(worker.lanes().register(cell));
    let epoch = r.transfer_epoch(lane, 1).unwrap();
    r.transfer(lane, 1, Custody::Cell(cell));
    assert!(worker.lanes().adopt(lane, 1, epoch, 7));
    assert_eq!(r.end_state(lane, 1), (end::OPEN, 7));
    assert_eq!(
        worker.lanes().transfer_epoch(lane, 1),
        Err(Refusal::Exhausted)
    );
    r.exited(cell);
    worker.release();
    r.sweep(Sweep::Full);
    let word = r.mem.get(at);
    assert_eq!(
        (word.kind, word.count),
        (end::CLOSED, MAX_COUNT),
        "the epoch stops at the limit"
    );
    assert_eq!(Word::unpack(word.pack()), word);
    r.close_end(lane, 0);
    assert_eq!(
        r.mem.get(r.lane_slot(lane.slot) + CLAIM).kind,
        phase::RELEASED
    );
    let next = r.create_lane().unwrap();
    assert_ne!(
        next.slot, lane.slot,
        "a lane whose epochs ran out is never used again"
    );
    r.close_end(next, 0);
    r.close_end(next, 1);
    r.sweep(Sweep::Trim);
    for _ in 0..3 {
        let again = r.create_lane().unwrap();
        assert_ne!(again.slot, lane.slot);
        r.close_end(again, 0);
        r.close_end(again, 1);
    }
}

#[test]
fn late_versions_and_severs_from_an_earlier_use_are_ignored() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let first = r.create_lane().unwrap();
    r.sever(first, 0);
    assert!(r.drain(first, 1, 8).unwrap().terminal);
    r.close_end(first, 0);
    r.close_end(first, 1);
    let second = r.create_lane().unwrap();
    assert_eq!(second.slot, first.slot);
    // A late sever aimed at the first use cannot mark the second.
    r.sever(first, 0);
    r.mem
        .raise(r.dir_at(first.slot, 1) + SEVERED, first.generation);
    assert!(!r.drain(second, 1, 8).unwrap().terminal);
    // A version not recorded for the current open epoch reads as unknown.
    let at = r.end_at(second.slot, 1);
    r.mem.put64(at + END_VERSION, 3);
    assert_eq!(r.end_state(second, 1), (end::OPEN, u32::MAX));
}

#[test]
fn the_epoch_sum_rises_with_every_end_transition() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let seen = Cell::new(r.epochs());
    let rose = |what: &str| {
        let now = r.epochs();
        assert!(now > seen.replace(now), "{what} left the sum unchanged");
    };
    let carrier = r.create_lane().unwrap();
    let carried = r.create_lane().unwrap();
    rose("creating lanes");
    r.transfer(carried, 1, Custody::Lane(carrier, 1));
    rose("a transfer");
    r.close_read(carrier, 1);
    assert_eq!(r.end_state(carried, 1).0, end::CLOSED);
    rose("a cascade closing");
    let cell = r.create_cell().unwrap();
    let worker = root.child();
    assert!(worker.lanes().register(cell));
    let epoch = r.transfer_epoch(carried, 0).unwrap();
    r.transfer(carried, 0, Custody::Cell(cell));
    assert!(worker.lanes().adopt(carried, 0, epoch, 1));
    rose("an adoption");
    r.exited(cell);
    rose("a death declaration");
    worker.release();
    r.sweep(Sweep::Full);
    rose("a release");
    r.close_end(carrier, 0);
    rose("a close");
}

/// Memory for a guest the host ends before its `stop`th access. The panic stands for that end:
/// nothing the guest still had to do happens.
struct Killed<'a> {
    inner: &'a Buffer,
    stop: usize,
    seen: Cell<usize>,
}

impl Memory for Killed<'_> {
    fn size(&self) -> u64 {
        self.inner.size()
    }
    fn raw(&self, at: u32, len: u32) -> *mut u8 {
        assert_ne!(self.seen.replace(self.seen.get() + 1), self.stop, "killed");
        self.inner.raw(at, len)
    }
}

#[test]
fn a_finalizer_killed_at_any_access_leaves_no_closure_unannounced_and_no_lane_behind() {
    let mut closed_by_the_dead = 0;
    for stop in 0.. {
        let group = Group::new(64);
        let root = Peer::root(&group);
        let finalizer = root.child();
        let r = root.lanes();
        let carrier = r.create_lane().unwrap();
        let carried = r.create_lane().unwrap();
        r.transfer(carried, 1, Custody::Lane(carrier, 1));
        r.close_end(carried, 0);
        // The carrier's reader stopped for good and no cascade has run yet.
        r.mem.put(r.dir_at(carrier.slot, 1) + READER_CLOSED, 1);
        let before = r.epochs();
        let killed = Killed {
            inner: &group.mem,
            stop,
            seen: Cell::new(0),
        };
        let dying = Lanes {
            mem: &killed,
            host: &finalizer.guest,
            ledger: root.ledger,
            tag: finalizer.tag,
        };
        let survived = catch_unwind(AssertUnwindSafe(|| dying.cascade())).is_ok();
        finalizer.release();
        // The root reads the end words only. A closed end has already changed their sum, with
        // no later write by the member that closed it.
        let closed = r.end_state(carried, 1).0 == end::CLOSED;
        assert_eq!(
            r.epochs() != before,
            closed,
            "stop {stop}: a closure and its announcement are one store"
        );
        closed_by_the_dead += usize::from(closed && !survived);
        // The next full sweep closes the end if the finalizer had not, and returns the lane
        // even when the finalizer died between its terminal swap and the lane's release.
        r.sweep(Sweep::Full);
        assert_eq!(r.end_state(carried, 1).0, end::CLOSED, "stop {stop}");
        assert!(r.live(carried).is_none(), "stop {stop}: the lane was left");
        r.close_end(carrier, 0);
        r.close_end(carrier, 1);
        assert_settled(&root);
        if survived {
            break;
        }
    }
    assert!(
        closed_by_the_dead > 0,
        "no stop fell after the terminal swap"
    );
}

#[test]
fn a_staged_frame_whose_reply_was_lost_is_settled_under_its_end() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    let fence = r.dir_at(lane.slot, 1) + WRITING;
    let mut unsettled = Unsettled::default();
    // The reply to this call never reached its caller, which knows only the end it named.
    unsettled.stage(&r, lane, 0, &frame(0, 40_000)).unwrap();
    assert_eq!(r.mem.load(fence), 1);
    unsettled.abort(&r, lane, 0);
    assert_eq!(r.mem.load(fence), 0, "the abort found the frame by its end");
    assert!(take(&r, lane, 1).is_empty(), "nothing became visible");
    // A caller that staged twice has one frame: the earlier one is abandoned first.
    unsettled.stage(&r, lane, 0, &frame(1, 40_000)).unwrap();
    unsettled.stage(&r, lane, 0, &frame(2, 40_000)).unwrap();
    assert!(
        unsettled.commit(&r, lane, 0),
        "the armed reader is due a wake"
    );
    assert_eq!(take(&r, lane, 1), [frame(2, 40_000)]);
    assert!(!unsettled.commit(&r, lane, 0), "a frame commits once");
    // An end that moves or closes takes its staged frame with it and frees the fence.
    unsettled.stage(&r, lane, 0, &frame(3, 40_000)).unwrap();
    let epoch = unsettled.transfer_epoch(&r, lane, 0).unwrap();
    unsettled.transfer(&r, lane, 0, Custody::Tag(root.tag));
    assert_eq!(r.mem.load(fence), 0);
    assert!(unsettled.is_empty());
    assert!(r.adopt(lane, 0, epoch, 1));
    unsettled.stage(&r, lane, 0, &frame(4, 40_000)).unwrap();
    unsettled.close_end(&r, lane, 0);
    assert_eq!(r.mem.load(fence), 0);
    r.close_end(lane, 1);
    assert!(unsettled.is_empty());
    assert_settled(&root);
}

#[test]
fn a_drained_batch_is_handed_out_again_until_it_is_acknowledged() {
    let group = Group::new(64);
    let root = Peer::root(&group);
    let r = root.lanes();
    let lane = r.create_lane().unwrap();
    let text = |index| String::from_utf8(frame(index, 100)).unwrap();
    for index in 0..3 {
        post(&r, lane, 0, &frame(index, 100));
    }
    let mut unsettled = Unsettled::default();
    let first = unsettled.receive(&r, lane, 1, 2).unwrap();
    assert_eq!(
        (first.frames.clone(), first.more),
        (vec![text(0), text(1)], true)
    );
    // The reply carrying that batch was lost. The next call returns it again, not what follows.
    assert_eq!(unsettled.receive(&r, lane, 1, 1024).unwrap(), first);
    // Frames held here are in neither the lane nor the port, so the end may not move yet.
    assert_eq!(
        unsettled.transfer_epoch(&r, lane, 1),
        Err(Refusal::Undelivered)
    );
    unsettled.acknowledge(lane, 1);
    assert!(unsettled.transfer_epoch(&r, lane, 1).is_ok());
    assert_eq!(
        unsettled.receive(&r, lane, 1, 1024).unwrap().frames,
        [text(2)]
    );
    unsettled.acknowledge(lane, 1);
    assert!(
        unsettled
            .receive(&r, lane, 1, 1024)
            .unwrap()
            .frames
            .is_empty()
    );
    assert!(unsettled.is_empty(), "an empty batch holds nothing back");
    // A reader that closes drops what it never took.
    post(&r, lane, 0, &frame(3, 100));
    unsettled.receive(&r, lane, 1, 8).unwrap();
    unsettled.close_read(&r, lane, 1);
    assert!(unsettled.is_empty());
}

/// A root, a sender and a receiver. The carrier lane runs from the sender (side 0) to the
/// receiver (side 1). The root keeps side 0 of each carried lane and the sender holds side 1.
struct Relay {
    group: Arc<Group>,
    root: Peer,
    sender: Peer,
    receiver: Peer,
    carrier: LaneRef,
    carried: Vec<LaneRef>,
}

fn relay(ports: usize) -> Relay {
    let group = Group::new(128);
    let root = Peer::root(&group);
    let sender = root.child();
    let receiver = root.child();
    let (r, s, d) = (root.lanes(), sender.lanes(), receiver.lanes());
    let hand = |lane: LaneRef, side: u32, to: &Lanes<'_, Buffer, Guest>| {
        let epoch = r.transfer_epoch(lane, side).unwrap();
        r.transfer(lane, side, Custody::Tag(root.tag));
        assert!(to.adopt(lane, side, epoch, 1));
    };
    let carrier = r.create_lane().unwrap();
    hand(carrier, 0, &s);
    hand(carrier, 1, &d);
    let carried: Vec<LaneRef> = (0..ports).map(|_| r.create_lane().unwrap()).collect();
    for lane in &carried {
        hand(*lane, 1, &s);
    }
    Relay {
        group,
        root,
        sender,
        receiver,
        carrier,
        carried,
    }
}

#[test]
fn a_staged_message_moves_its_ports_and_publishes_in_one_commit() {
    let relay = relay(2);
    let (r, s, d) = (
        relay.root.lanes(),
        relay.sender.lanes(),
        relay.receiver.lanes(),
    );
    let (carrier, first, second) = (relay.carrier, relay.carried[0], relay.carried[1]);
    let mut unsettled = Unsettled::default();
    assert_eq!(unsettled.committed(), 0, "no commit yet");
    unsettled.stage(&s, carrier, 0, b"two ports").unwrap();
    let epochs = [first, second].map(|lane| unsettled.stage_end(&s, carrier, 0, lane, 1).unwrap());
    // Naming an end moves nothing and shows nothing.
    assert_eq!(s.end_state(first, 1).0, end::OPEN);
    assert!(take(&d, carrier, 1).is_empty());
    assert_eq!(unsettled.commit_check(&s, carrier, 0), Ok(()));
    unsettled.commit_staged(&s, carrier, 0, 7);
    assert_eq!(
        unsettled.committed(),
        7 * 2 + 1,
        "the armed reader is due a wake"
    );
    for lane in [first, second] {
        let at = s.end_at(lane.slot, 1);
        assert_eq!(s.mem.get(at).kind, end::IN_FLIGHT);
        let custody = decode_custody(s.mem.load(at + CUSTODY), s.mem.load(at + CUSTODY_ARG));
        assert_eq!(
            custody,
            Some(Custody::Lane(carrier, 1)),
            "the frame's reader holds it"
        );
    }
    assert_eq!(take(&d, carrier, 1), [b"two ports".to_vec()]);
    for (lane, epoch) in [first, second].into_iter().zip(epochs) {
        assert!(d.adopt(lane, 1, epoch, 2));
        post(&d, lane, 1, b"from the adopter");
        assert_eq!(take(&r, lane, 0), [b"from the adopter".to_vec()]);
    }
    // A commit happens once, and a later one without a wake clears the bit.
    unsettled.commit_staged(&s, carrier, 0, 8);
    assert_eq!(
        unsettled.committed(),
        7 * 2 + 1,
        "nothing staged: nothing recorded"
    );
    for (nonce, word) in [(9, 9 * 2 + 1), (10, 10 * 2)] {
        unsettled.stage(&s, carrier, 0, b"no ports").unwrap();
        assert_eq!(unsettled.commit_check(&s, carrier, 0), Ok(()));
        unsettled.commit_staged(&s, carrier, 0, nonce);
        assert_eq!(
            unsettled.committed(),
            word,
            "only a reader that drained is armed"
        );
    }
    assert!(unsettled.is_empty());
}

#[test]
fn an_end_is_refused_while_the_message_can_still_be_refused() {
    let relay = relay(2);
    let (r, s) = (relay.root.lanes(), relay.sender.lanes());
    let (carrier, first, second) = (relay.carrier, relay.carried[0], relay.carried[1]);
    let mut unsettled = Unsettled::default();
    let stage_end =
        |unsettled: &mut Unsettled, lane, side| unsettled.stage_end(&s, carrier, 0, lane, side);
    assert_eq!(
        stage_end(&mut unsettled, first, 1),
        Err(Refusal::Stale),
        "no frame staged"
    );
    unsettled.stage(&s, carrier, 0, b"frame").unwrap();
    assert_eq!(
        stage_end(&mut unsettled, carrier, 1),
        Err(Refusal::Stale),
        "its own lane"
    );
    assert_eq!(
        stage_end(&mut unsettled, first, 0),
        Err(Refusal::NotOwned),
        "the root's end"
    );
    assert_eq!(
        stage_end(&mut unsettled, first, 2),
        Err(Refusal::NotOwned),
        "no such side"
    );
    let missing = LaneRef {
        slot: LANE_SLOTS,
        generation: 1,
    };
    assert_eq!(
        stage_end(&mut unsettled, missing, 0),
        Err(Refusal::NotOwned)
    );
    // Frames read for this thread and not yet taken would be lost to the next owner.
    post(&r, second, 0, b"unread");
    unsettled.receive(&s, second, 1, 8).unwrap();
    assert_eq!(
        stage_end(&mut unsettled, second, 1),
        Err(Refusal::Undelivered)
    );
    unsettled.acknowledge(second, 1);
    // An end whose epochs would not last through the move and its terminal transitions.
    let at = s.end_at(second.slot, 1);
    let open = s.mem.get(at);
    s.mem.set(at, Word::new(open.tag, MAX_COUNT - 1, end::OPEN));
    assert_eq!(
        stage_end(&mut unsettled, second, 1),
        Err(Refusal::Exhausted)
    );
    s.mem.set(at, open);
    assert!(stage_end(&mut unsettled, first, 1).is_ok());
    assert_eq!(
        stage_end(&mut unsettled, first, 1),
        Err(Refusal::Stale),
        "an end travels once"
    );
    // Every refusal left the frame staged with the one end it accepted.
    assert_eq!(unsettled.commit_check(&s, carrier, 0), Ok(()));
    unsettled.abort(&s, carrier, 0);
    unsettled.abort(&s, carrier, 0);
    assert!(unsettled.is_empty());
    assert_eq!(
        s.end_state(first, 1).0,
        end::OPEN,
        "an abort has nothing to undo"
    );
}

#[test]
fn a_stale_plan_is_refused_before_anything_moves() {
    let relay = relay(2);
    let (r, s, d) = (
        relay.root.lanes(),
        relay.sender.lanes(),
        relay.receiver.lanes(),
    );
    let (carrier, first, second) = (relay.carrier, relay.carried[0], relay.carried[1]);
    let mut unsettled = Unsettled::default();
    let untouched = |unsettled: &Unsettled, why: &str| {
        assert_eq!(unsettled.committed(), 0, "{why}");
        assert!(take(&d, carrier, 1).is_empty(), "{why}");
        assert_eq!(s.end_state(first, 1).0, end::OPEN, "{why}");
    };
    assert_eq!(
        unsettled.commit_check(&s, carrier, 0),
        Err(Refusal::Stale),
        "nothing staged"
    );
    assert_eq!(
        unsettled.commit_check(&s, carrier, 2),
        Err(Refusal::NotOwned)
    );
    // A carried end that received frames after it was named.
    unsettled.stage(&s, carrier, 0, b"frame").unwrap();
    unsettled.stage_end(&s, carrier, 0, first, 1).unwrap();
    unsettled.stage_end(&s, carrier, 0, second, 1).unwrap();
    post(&r, second, 0, b"late");
    unsettled.receive(&s, second, 1, 8).unwrap();
    assert_eq!(
        unsettled.commit_check(&s, carrier, 0),
        Err(Refusal::Undelivered)
    );
    unsettled.acknowledge(second, 1);
    assert_eq!(unsettled.commit_check(&s, carrier, 0), Ok(()));
    // A carried end that left and came back is open again, at another epoch.
    let epoch = unsettled.transfer_epoch(&s, second, 1).unwrap();
    unsettled.transfer(&s, second, 1, Custody::Tag(relay.sender.tag));
    assert_eq!(
        unsettled.commit_check(&s, carrier, 0),
        Err(Refusal::NotOwned)
    );
    assert!(s.adopt(second, 1, epoch, 2));
    assert_eq!(unsettled.commit_check(&s, carrier, 0), Err(Refusal::Stale));
    untouched(&unsettled, "a moved end");
    // Staging again replaces the whole plan: the ends named before are forgotten.
    unsettled.stage(&s, carrier, 0, b"again").unwrap();
    assert_eq!(unsettled.commit_check(&s, carrier, 0), Ok(()));
    unsettled.stage_end(&s, carrier, 0, second, 1).unwrap();
    // A carried end that closed.
    unsettled.close_end(&s, second, 1);
    assert_eq!(
        unsettled.commit_check(&s, carrier, 0),
        Err(Refusal::NotOwned)
    );
    untouched(&unsettled, "a closed end");
    // The plain commit never publishes a frame that names ends: they would not have moved.
    assert!(!unsettled.commit(&s, carrier, 0));
    untouched(&unsettled, "a plain commit");
    assert!(unsettled.is_empty());
    // The sender end closing takes the plan with it.
    unsettled.stage(&s, carrier, 0, b"last").unwrap();
    unsettled.stage_end(&s, carrier, 0, first, 1).unwrap();
    unsettled.close_end(&s, carrier, 0);
    assert_eq!(
        unsettled.commit_check(&s, carrier, 0),
        Err(Refusal::NotOwned)
    );
    assert!(unsettled.is_empty());
    assert_eq!(s.end_state(first, 1).0, end::OPEN);
}

#[test]
fn a_carried_end_takes_its_own_abandoned_frame_with_it() {
    let relay = relay(1);
    let s = relay.sender.lanes();
    let (carrier, carried) = (relay.carrier, relay.carried[0]);
    let fence = s.dir_at(carried.slot, 0) + WRITING;
    let mut unsettled = Unsettled::default();
    unsettled.stage(&s, carried, 1, &frame(0, 40_000)).unwrap();
    assert_eq!(s.mem.load(fence), 1);
    unsettled.stage(&s, carrier, 0, b"frame").unwrap();
    unsettled.stage_end(&s, carrier, 0, carried, 1).unwrap();
    assert_eq!(
        s.mem.load(fence),
        0,
        "naming the end abandoned what it had staged"
    );
    // One staged after it was named goes when the end does.
    unsettled.stage(&s, carried, 1, &frame(1, 40_000)).unwrap();
    assert_eq!(unsettled.commit_check(&s, carrier, 0), Ok(()));
    unsettled.commit_staged(&s, carrier, 0, 1);
    assert_eq!(s.mem.load(fence), 0);
    assert!(unsettled.is_empty());
}

#[test]
fn a_nonce_and_its_wake_bit_fit_one_exact_number() {
    assert_eq!(nonce(0, 0), Err(Refusal::Range), "zero means no commit");
    assert_eq!(nonce(0, 1), Ok(1));
    assert_eq!(nonce(1, 0), Ok(1 << 32));
    assert_eq!(nonce((1 << 20) - 1, u32::MAX), Ok(MAX_NONCE));
    assert_eq!(nonce(1 << 20, 0), Err(Refusal::Range));
    assert_eq!(nonce(u32::MAX, u32::MAX), Err(Refusal::Range));
    let relay = relay(0);
    let s = relay.sender.lanes();
    let mut unsettled = Unsettled::default();
    for (value, wake) in [
        (1, true),
        (1 << 32, false),
        (MAX_NONCE, false),
        (MAX_NONCE, true),
    ] {
        if wake {
            // A reader that drained to empty asks for a wake at the next commit.
            take(&relay.receiver.lanes(), relay.carrier, 1);
        }
        unsettled.stage(&s, relay.carrier, 0, b"frame").unwrap();
        unsettled.commit_staged(&s, relay.carrier, 0, value);
        let word = unsettled.committed();
        assert_eq!(word >> 1, value);
        assert_eq!(word & 1 == 1, wake, "nonce {value}");
        // The word adapter hands the result to JavaScript as a double.
        let number = word as i64 as f64;
        assert_eq!(number as u64, word, "nonce {value} survives the number");
        assert_eq!(((number - number % 2.0) / 2.0) as u64, value);
    }
    assert_eq!(MAX_NONCE * 2 + 1, (1 << 53) - 1);
}

#[test]
fn a_sender_killed_at_any_access_of_the_commit_leaves_the_message_absent_or_whole() {
    for len in [64, 300_000] {
        let (mut absent, mut whole_after_death) = (0, 0);
        for stop in 0.. {
            let relay = relay(2);
            let (r, s, d) = (
                relay.root.lanes(),
                relay.sender.lanes(),
                relay.receiver.lanes(),
            );
            let (carrier, carried) = (relay.carrier, &relay.carried);
            let mut unsettled = Unsettled::default();
            unsettled.stage(&s, carrier, 0, &frame(stop, len)).unwrap();
            let epochs: Vec<u32> = carried
                .iter()
                .map(|lane| unsettled.stage_end(&s, carrier, 0, *lane, 1).unwrap())
                .collect();
            unsettled.commit_check(&s, carrier, 0).unwrap();
            let killed = Killed {
                inner: &relay.group.mem,
                stop,
                seen: Cell::new(0),
            };
            let dying = Lanes {
                mem: &killed,
                host: &relay.sender.guest,
                ledger: relay.root.ledger,
                tag: relay.sender.tag,
            };
            let commit = || unsettled.commit_staged(&dying, carrier, 0, 1);
            let survived = catch_unwind(AssertUnwindSafe(commit)).is_ok();
            relay.sender.release();
            r.sweep(Sweep::Full);
            let got = take(&d, carrier, 1);
            if got.is_empty() {
                // No frame names the ports. Whichever of them already moved wait with the
                // frame's reader and close when it does; the others died with the sender.
                assert!(!survived, "stop {stop}: a finished commit shows its frame");
                absent += 1;
                d.close_end(carrier, 1);
                r.sweep(Sweep::Full);
                for lane in carried {
                    assert_eq!(r.end_state(*lane, 1).0, end::CLOSED, "stop {stop}");
                    assert!(r.drain(*lane, 0, 8).unwrap().terminal, "stop {stop}");
                }
            } else {
                // The publication store is the last one that matters: every port it names is
                // already in the reader's custody.
                assert_eq!(got, [frame(stop, len)], "stop {stop}");
                whole_after_death += usize::from(!survived);
                for (lane, epoch) in carried.iter().zip(&epochs) {
                    assert!(d.adopt(*lane, 1, *epoch, 2), "stop {stop}");
                    post(&d, *lane, 1, b"from the adopter");
                    assert_eq!(take(&r, *lane, 0), [b"from the adopter".to_vec()]);
                }
            }
            if survived {
                break;
            }
        }
        assert!(
            absent > 0,
            "length {len}: no stop fell before the publication store"
        );
        assert!(whole_after_death > 0, "length {len}: no stop fell after it");
    }
}
