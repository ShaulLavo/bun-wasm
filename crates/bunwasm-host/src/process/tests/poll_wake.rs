use super::*;
use std::cell::Cell;
use std::sync::mpsc;

const ROUNDS: u32 = 64;

fn watched_pipe(p: &mut Processes) -> (i32, i32, Vec<u8>) {
    let [read, write] = p.pipe().unwrap();
    let [scan_end, _] = p.pipe().unwrap();
    let mut subscriptions = subscription(0, read, 17);
    subscriptions.extend(subscription(0, scan_end, 29));
    (read, write, subscriptions)
}

fn assert_read_event(events: &[u8]) {
    assert_eq!(events.len(), 16);
    assert_eq!(u64::from_le_bytes(events[..8].try_into().unwrap()), 17);
    assert_eq!(u32::from_le_bytes(events[8..12].try_into().unwrap()), 0);
}

fn assert_not_periodic(elapsed: Duration) {
    eprintln!("{ROUNDS} poll publication rounds: {elapsed:?}");
    // A restored 10 ms sleep costs at least 640 ms for these 64 empty scans.
    // Allow 320 ms for scheduling noise without asserting a sub-millisecond wake.
    assert!(
        elapsed < Duration::from_millis(320),
        "poll waited for periodic rescans instead of pipe notifications: {elapsed:?}"
    );
}

#[test]
fn generation_change_after_readiness_check_does_not_sleep() {
    let mut p = processes();
    let (read, write, subscriptions) = watched_pipe(&mut p);
    let scan_end = i32::from_le_bytes(subscriptions[20..24].try_into().unwrap());
    let start = Instant::now();
    for _ in 0..ROUNDS {
        let published = Cell::new(false);
        let events = p
            .poll_with_files(&subscriptions, 1000, |fd| {
                publish_during_scan(&p, fd, scan_end, write, &published)
            })
            .unwrap();
        assert_read_event(&events);
        assert_eq!(p.read(read, &mut [0]), 1, "poll must not consume bytes");
    }
    assert_not_periodic(start.elapsed());
}

fn publish_after_scan(requests: mpsc::Receiver<()>, writer: Arc<Endpoint>, notify: Arc<Notify>) {
    while requests.recv_timeout(Duration::from_secs(2)).is_ok() {
        std::thread::sleep(Duration::from_millis(1));
        assert_eq!(writer.write(b"x", &notify), 1);
    }
}

fn delayed_round(p: &Processes, subscriptions: &[u8], requests: &mpsc::Sender<()>) {
    let scan_end = i32::from_le_bytes(subscriptions[20..24].try_into().unwrap());
    let sent = Cell::new(false);
    let events = p
        .poll_with_files(subscriptions, 1000, |fd| {
            if fd == scan_end && !sent.replace(true) {
                requests.send(()).unwrap();
            }
            false
        })
        .unwrap();
    assert_read_event(&events);
}

#[test]
fn pipe_publication_wakes_a_waiting_poll_without_periodic_delay() {
    let mut p = processes();
    let (read, write, subscriptions) = watched_pipe(&mut p);
    let writer = p.fds[&write].clone();
    let notify = p.notify.clone();
    std::thread::scope(|scope| {
        let (send, receive) = mpsc::channel();
        let publisher = scope.spawn(|| publish_after_scan(receive, writer, notify));
        let start = Instant::now();
        for _ in 0..ROUNDS {
            delayed_round(&p, &subscriptions, &send);
            assert_eq!(p.read(read, &mut [0]), 1);
        }
        let elapsed = start.elapsed();
        drop(send);
        publisher.join().unwrap();
        assert_not_periodic(elapsed);
    });
}

#[test]
fn timeout_zero_scans_once_and_leaves_ready_bytes_untouched() {
    let mut p = processes();
    let [read, write] = p.pipe().unwrap();
    let scans = Cell::new(0);
    let subscriptions = subscription(0, read, 17);
    assert!(
        p.poll_with_files(&subscriptions, 0, |_| {
            scans.set(scans.get() + 1);
            false
        })
        .unwrap()
        .is_empty()
    );
    assert_eq!(scans.get(), 1);
    assert_eq!(p.write(write, b"x"), 1);
    for _ in 0..2 {
        assert_read_event(&p.poll_with_files(&subscriptions, 0, |_| false).unwrap());
    }
    assert_eq!(p.read(read, &mut [0]), 1);
    assert!(
        p.poll_with_files(&subscriptions, 0, |_| false)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn eof_publication_releases_poll_and_remains_level_triggered() {
    let mut p = processes();
    let (read, write, subscriptions) = watched_pipe(&mut p);
    let writer = p.fds.remove(&write).unwrap();
    let scan_end = i32::from_le_bytes(subscriptions[20..24].try_into().unwrap());
    std::thread::scope(|scope| {
        let (send, receive) = mpsc::sync_channel(1);
        let closer = scope.spawn(move || {
            receive.recv_timeout(Duration::from_secs(2)).unwrap();
            drop(writer);
        });
        let sent = Cell::new(false);
        let events = p
            .poll_with_files(&subscriptions, 1000, |fd| {
                release_closer(fd, scan_end, &sent, &send)
            })
            .unwrap();
        closer.join().unwrap();
        assert_read_event(&events);
        assert_eq!(u32::from_le_bytes(events[12..16].try_into().unwrap()), 1);
    });
    assert_read_event(&p.poll_with_files(&subscriptions, 0, |_| false).unwrap());
    assert_eq!(p.read(read, &mut [0]), 0);
}

#[test]
fn child_and_job_poll_results_are_nonconsuming() {
    let mut p = processes();
    let pid = p.spawn(&request("/bin/bun", serde_json::json!([])));
    assert!(pid > 0);
    let job = p.job_of(pid);
    let mut subscriptions = subscription(2, pid, 17);
    subscriptions.extend(subscription(4, job, 29));
    assert!(
        !p.poll_with_files(&subscriptions, 1000, |_| false)
            .unwrap()
            .is_empty()
    );
    for _ in 0..2 {
        assert_eq!(
            p.poll_with_files(&subscriptions, 1000, |_| false)
                .unwrap()
                .len(),
            32
        );
    }
    assert_eq!(p.wait(pid), Ok(FinalOutcome::Exit(0)));
    assert_eq!(p.wait_job(job, 1), Ok(FinalOutcome::Exit(0)));
    assert_eq!(p.wait(pid), Err(CHILD));
    assert_eq!(p.wait_job(job, 1), Err(CHILD));
}

#[test]
fn cancellation_while_polling_returns_without_consuming_signal() {
    let mut p = processes();
    let (read, _, subscriptions) = watched_pipe(&mut p);
    let sent = Cell::new(false);
    assert!(
        p.poll_with_files(&subscriptions, 1000, |_| {
            if !sent.replace(true) {
                assert!(p.cancel.kill(15));
            }
            false
        })
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        p.cancel.select(FinalOutcome::Exit(0)),
        FinalOutcome::Signal(15)
    );
    assert_eq!(p.read(read, &mut [0]), AGAIN);
}

fn release_closer(fd: i32, scan_end: i32, sent: &Cell<bool>, send: &mpsc::SyncSender<()>) -> bool {
    if fd == scan_end && !sent.replace(true) {
        send.send(()).unwrap();
    }
    false
}

fn publish_during_scan(
    p: &Processes,
    fd: i32,
    scan_end: i32,
    write: i32,
    published: &Cell<bool>,
) -> bool {
    if fd != scan_end || published.replace(true) {
        return false;
    }
    assert_eq!(p.write(write, b"x"), 1);
    false
}
