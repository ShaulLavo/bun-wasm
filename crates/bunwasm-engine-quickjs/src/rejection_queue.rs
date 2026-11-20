//! The rejections of a turn that have no handler yet, in rejection order, for the engines whose
//! tracker reports both the rejection and the first handler (QuickJS and JSC). Bun's
//! `RejectedPromiseQueue` (src/jsc/bindings/RejectedPromiseQueue.h) is the model: the event loop
//! takes one entry at a time, so a handler attached while an earlier one is being reported keeps
//! the later one from being reported. Adding, handling and taking are O(1) amortized, and a
//! handled entry drops its values at once, so the queue never keeps a handled promise alive.

use std::collections::{HashMap, VecDeque};

pub(crate) struct RejectionQueue<T> {
    /// Rejection order. `None` marks an entry whose promise got a handler.
    entries: VecDeque<Option<(usize, T)>>,
    /// Sequence number of `entries[0]`.
    first: u64,
    /// Promise identity to sequence number, for the entries that are still `Some`.
    index: HashMap<usize, u64>,
}

impl<T> RejectionQueue<T> {
    pub(crate) fn new() -> Self {
        RejectionQueue {
            entries: VecDeque::new(),
            first: 0,
            index: HashMap::new(),
        }
    }

    /// A promise rejected with no handler. `key` is its identity (an object address).
    pub(crate) fn push(&mut self, key: usize, entry: T) {
        if self.entries.len() >= 64 && self.index.len() * 2 < self.entries.len() {
            self.compact();
        }
        let sequence = self.first + self.entries.len() as u64;
        self.entries.push_back(Some((key, entry)));
        self.index.insert(key, sequence);
    }

    /// The promise got its first handler. Returns its entry if it was still waiting here; none
    /// means it was taken earlier (for reporting) or was never queued.
    pub(crate) fn remove(&mut self, key: usize) -> Option<T> {
        let sequence = self.index.remove(&key)?;
        let slot = (sequence - self.first) as usize;
        let entry = self.entries[slot].take().map(|(_, entry)| entry);
        while matches!(self.entries.back(), Some(None)) {
            self.entries.pop_back();
        }
        entry
    }

    /// The oldest entry still without a handler.
    pub(crate) fn pop(&mut self) -> Option<T> {
        while let Some(slot) = self.entries.pop_front() {
            self.first += 1;
            if let Some((key, entry)) = slot {
                self.index.remove(&key);
                return Some(entry);
            }
        }
        None
    }

    /// Drop the handled entries, so a turn that handles most rejections late (but never the
    /// newest one) keeps memory in proportion to what is still unhandled.
    fn compact(&mut self) {
        self.entries.retain(Option::is_some);
        for (offset, slot) in self.entries.iter().enumerate() {
            if let Some((key, _)) = slot {
                self.index.insert(*key, self.first + offset as u64);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RejectionQueue;

    fn drain(queue: &mut RejectionQueue<usize>) -> Vec<usize> {
        std::iter::from_fn(|| queue.pop()).collect()
    }

    #[test]
    fn keeps_rejection_order_and_skips_handled_entries() {
        let mut queue = RejectionQueue::new();
        for key in 1..=4 {
            queue.push(key, key * 10);
        }
        assert_eq!(queue.remove(2), Some(20));
        assert_eq!(queue.remove(4), Some(40));
        assert_eq!(queue.remove(4), None);
        assert_eq!(queue.pop(), Some(10));
        // Taken entries are no longer queued: a handler now is a late one.
        assert_eq!(queue.remove(1), None);
        assert_eq!(drain(&mut queue), [30]);
    }

    #[test]
    fn compaction_keeps_the_index_valid() {
        let mut queue = RejectionQueue::new();
        for key in 0..300 {
            queue.push(key, key * 10);
            // Handle each one a step late, except every 7th.
            if key > 0 && (key - 1) % 7 != 0 {
                assert!(queue.remove(key - 1).is_some());
            }
        }
        assert!(queue.entries.len() < 150, "{}", queue.entries.len());
        assert_eq!(queue.remove(15), None);
        assert_eq!(queue.remove(14), Some(140));
        let expected: Vec<usize> = (0..300)
            .filter(|i| (i % 7 == 0 && *i != 14) || *i == 299)
            .map(|i| i * 10)
            .collect();
        assert_eq!(drain(&mut queue), expected);
    }
}
