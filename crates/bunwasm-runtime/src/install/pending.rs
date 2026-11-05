//! How long the installer sleeps in the host's `poll` while one request is outstanding.
//!
//! `poll` returns as soon as the host has news (docs/host-abi.md), so its timeout only bounds what
//! a notification that never arrives costs. The timeout starts short, doubles up to a small cap,
//! and starts over whenever the request makes progress. Nothing polls while no request is
//! outstanding.

use std::time::{Duration, Instant};

const FIRST_POLL: Duration = Duration::from_millis(5);
const POLL_CAP: Duration = Duration::from_millis(50);

/// One outstanding request: its progress deadline and the next fallback poll timeout.
pub struct Pending {
    timeout: Duration,
    progress: Instant,
    poll: Duration,
}

impl Pending {
    pub fn new(timeout: Duration, now: Instant) -> Self {
        Self {
            timeout,
            progress: now,
            poll: FIRST_POLL,
        }
    }

    /// The request moved (head or body bytes arrived): restart its deadline and its backoff.
    pub fn progressed(&mut self, now: Instant) {
        self.progress = now;
        self.poll = FIRST_POLL;
    }

    /// The next `poll` timeout in milliseconds, at least 1 and never past the deadline, or `None`
    /// once the request has gone `timeout` without progress.
    pub fn next_poll_ms(&mut self, now: Instant) -> Option<i32> {
        let remaining = self
            .timeout
            .checked_sub(now.saturating_duration_since(self.progress))
            .filter(|remaining| !remaining.is_zero())?;
        let poll = self.poll.min(remaining);
        self.poll = (self.poll * 2).min(POLL_CAP);
        Some(poll.as_millis().max(1) as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);
    const TIMEOUT: Duration = Duration::from_secs(300);

    /// Serial polls when the host never notifies: each one sleeps its whole timeout. Returns when
    /// the guest first re-checks at or after `ready` (the response landed then), and the polls.
    fn dropped_notifications(ready: Duration) -> (Duration, usize) {
        let start = Instant::now();
        let mut pending = Pending::new(TIMEOUT, start);
        let mut now = start;
        let mut polls = 0;
        while now - start < ready {
            let poll = pending.next_poll_ms(now).expect("deadline is far away");
            now += MS * poll as u32;
            polls += 1;
        }
        (now - start, polls)
    }

    fn polls(pending: &mut Pending, now: Instant, count: usize) -> Vec<i32> {
        (0..count)
            .map(|_| pending.next_poll_ms(now).unwrap())
            .collect()
    }

    #[test]
    fn dropped_notification_costs_at_most_one_capped_poll() {
        for ready_ms in [0, 1, 3, 7, 30, 100, 999, 1000, 5000] {
            let ready = MS * ready_ms;
            let (noticed, polls) = dropped_notifications(ready);
            assert!(noticed >= ready);
            assert!(
                noticed - ready <= MS * 50,
                "response ready at {ready_ms} ms was noticed at {noticed:?}"
            );
            assert!(
                polls <= 4 + ready_ms as usize / 50 + 1,
                "{polls} polls for {ready_ms} ms"
            );
        }
    }

    #[test]
    fn backoff_starts_short_and_doubles_to_the_cap() {
        let now = Instant::now();
        let mut pending = Pending::new(TIMEOUT, now);
        assert_eq!(polls(&mut pending, now, 7), [5, 10, 20, 40, 50, 50, 50]);
    }

    #[test]
    fn progress_and_new_requests_restart_the_backoff() {
        let start = Instant::now();
        let mut pending = Pending::new(TIMEOUT, start);
        polls(&mut pending, start, 6);
        pending.progressed(start + MS * 200);
        assert_eq!(polls(&mut pending, start + MS * 200, 3), [5, 10, 20]);
        let mut next = Pending::new(TIMEOUT, start + MS * 400);
        assert_eq!(next.next_poll_ms(start + MS * 400), Some(5));
    }

    #[test]
    fn every_timeout_is_finite_and_never_zero() {
        let now = Instant::now();
        let mut pending = Pending::new(TIMEOUT, now);
        let waits = polls(&mut pending, now, 100);
        assert!(waits.iter().all(|&ms| (1..=50).contains(&ms)), "{waits:?}");
    }

    #[test]
    fn progress_deadline_is_unchanged() {
        let start = Instant::now();
        let mut pending = Pending::new(TIMEOUT, start);
        polls(&mut pending, start, 6);
        assert_eq!(pending.next_poll_ms(start + TIMEOUT - MS * 3), Some(3));
        assert_eq!(pending.next_poll_ms(start + TIMEOUT - MS / 2), Some(1));
        assert_eq!(pending.next_poll_ms(start + TIMEOUT), None);
        assert_eq!(pending.next_poll_ms(start + TIMEOUT + MS), None);
        pending.progressed(start + TIMEOUT - MS);
        assert_eq!(pending.next_poll_ms(start + TIMEOUT * 2 - MS * 2), Some(1));
        assert_eq!(pending.next_poll_ms(start + TIMEOUT * 2 - MS), None);
    }
}
