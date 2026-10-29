use super::*;
use crate::net::Net;
use std::fs;

/// A scratch directory removed on drop, and a watch table wired to a real network poll.
struct Fixture {
    root: PathBuf,
    net: Net,
    watches: Watches,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("bun-wasm-fs-watch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).unwrap();
        let net = Net::new();
        let watches = Watches::new(net.notify());
        Self { root, net, watches }
    }
    /// Drain the watch until EAGAIN after the poll wakes, as Bun's waiter does.
    fn drain(&mut self, id: u32) -> Vec<(u8, Option<String>)> {
        let mut records = Vec::new();
        loop {
            match self.watches.read(id, 64 * 1024) {
                Read::Records(bytes) if bytes.is_empty() => return records,
                Read::Records(bytes) => records.extend(decode(&bytes)),
                Read::Errno(AGAIN) => return records,
                other => panic!("unexpected read {other:?}"),
            }
        }
    }
    /// Wait for the commit's wake, then drain; repeat until `wanted` shows up or 5 s pass.
    fn expect(&mut self, id: u32, wanted: (u8, Option<&str>)) -> Vec<(u8, Option<String>)> {
        let wanted = (wanted.0, wanted.1.map(str::to_string));
        let mut seen = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !seen.contains(&wanted) {
            assert!(
                std::time::Instant::now() < deadline,
                "missing {wanted:?} in {seen:?}"
            );
            self.net.poll(1000);
            seen.extend(self.drain(id));
        }
        seen
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn decode(mut bytes: &[u8]) -> Vec<(u8, Option<String>)> {
    let mut records = Vec::new();
    while !bytes.is_empty() {
        assert_eq!(&bytes[1..4], &[0, 0, 0]);
        let length = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if length == NULL_NAME {
            records.push((bytes[0], None));
            bytes = &bytes[8..];
            continue;
        }
        let end = 8 + length as usize;
        records.push((
            bytes[0],
            Some(String::from_utf8(bytes[8..end].to_vec()).unwrap()),
        ));
        let stride = 8 + (length as usize).next_multiple_of(4);
        assert!(
            bytes[end..stride].iter().all(|&byte| byte == 0),
            "zero padding"
        );
        bytes = &bytes[stride..];
    }
    records
}

#[test]
fn a_commit_wakes_the_network_poll_and_drains_as_a_directory_record() {
    let mut f = Fixture::new("wake");
    let id = f.watches.open(&f.root, false).unwrap();
    assert_eq!(f.watches.read(id, 4096), Read::Errno(AGAIN));
    fs::write(f.root.join("page.tsx"), "export default 1").unwrap();
    assert_eq!(
        f.net.poll(5000),
        1,
        "the commit wakes the poll without a timer"
    );
    f.expect(id, (RENAME, Some("page.tsx")));
    fs::write(f.root.join("page.tsx"), "export default 2").unwrap();
    f.expect(id, (CHANGE, Some("page.tsx")));
}

#[test]
fn recursive_names_descendants_and_a_direct_watch_skips_them() {
    let mut f = Fixture::new("recursive");
    let direct = f.watches.open(&f.root, false).unwrap();
    let recursive = f.watches.open(&f.root, true).unwrap();
    fs::write(f.root.join("nested/deep.txt"), "x").unwrap();
    fs::write(f.root.join("top.txt"), "x").unwrap();
    f.expect(recursive, (RENAME, Some("nested/deep.txt")));
    let direct_names = f.expect(direct, (RENAME, Some("top.txt")));
    assert!(
        direct_names
            .iter()
            .all(|(_, name)| name.as_deref() != Some("nested/deep.txt")),
        "{direct_names:?}"
    );
}

#[test]
fn a_file_watch_reports_a_null_name() {
    let mut f = Fixture::new("file");
    let file = f.root.join("one.txt");
    fs::write(&file, "a").unwrap();
    let id = f.watches.open(&file, true).unwrap();
    fs::write(&file, "b").unwrap();
    f.expect(id, (CHANGE, None));
}

#[test]
fn a_record_that_does_not_fit_reports_its_size_and_consumes_nothing() {
    let mut f = Fixture::new("nobufs");
    let id = f.watches.open(&f.root, false).unwrap();
    fs::write(f.root.join("abcde"), "x").unwrap();
    f.net.poll(5000);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let needed = loop {
        match f.watches.read(id, 8) {
            Read::Short(needed) => break needed,
            Read::Errno(AGAIN) if std::time::Instant::now() < deadline => {
                f.net.poll(100);
            }
            other => panic!("unexpected read {other:?}"),
        }
    };
    assert_eq!(needed, 16, "8-byte header plus 5 bytes padded to 8");
    let Read::Records(bytes) = f.watches.read(id, needed as usize) else {
        panic!("retry with the reported size")
    };
    assert_eq!(decode(&bytes)[0], (RENAME, Some("abcde".into())));
}

#[test]
fn a_full_queue_becomes_one_terminal_overflow_then_end_of_stream() {
    let mut f = Fixture::new("overflow");
    let id = f.watches.open(&f.root, false).unwrap();
    for index in 0..=QUEUE {
        fs::write(f.root.join(format!("f{index}")), "x").unwrap();
    }
    // Wait until every create has been delivered, then let one drain see them all.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while f.watches.open[&id].inbox.lock().unwrap().events.len() <= QUEUE {
        assert!(
            std::time::Instant::now() < deadline,
            "notifications did not arrive"
        );
        f.net.poll(100);
    }
    assert_eq!(f.drain(id), vec![(OVERFLOW, None)]);
    assert_eq!(f.watches.read(id, 4096), Read::Records(Vec::new()));
    fs::write(f.root.join("after"), "x").unwrap();
    assert_eq!(
        f.watches.read(id, 4096),
        Read::Records(Vec::new()),
        "end is sticky"
    );
}

#[test]
fn identical_unread_records_coalesce() {
    let mut f = Fixture::new("coalesce");
    let file = f.root.join("same.txt");
    fs::write(&file, "0").unwrap();
    let id = f.watches.open(&file, false).unwrap();
    for value in 1..20 {
        fs::write(&file, value.to_string()).unwrap();
    }
    let seen = f.expect(id, (CHANGE, None));
    assert_eq!(
        seen.iter()
            .filter(|record| **record == (CHANGE, None))
            .count(),
        1
    );
}

#[test]
fn ids_close_once_and_missing_nodes_fail_registration() {
    let mut f = Fixture::new("close");
    assert_eq!(f.watches.open(&f.root.join("missing"), false), Err(NOENT));
    let first = f.watches.open(&f.root, false).unwrap();
    let second = f.watches.open(&f.root, false).unwrap();
    assert_ne!(first, second);
    assert_eq!(f.watches.close(first), 0);
    assert_eq!(f.watches.close(first), BADF);
    assert_eq!(f.watches.read(first, 4096), Read::Errno(BADF));
    let third = f.watches.open(&f.root, false).unwrap();
    assert!(third > second, "ids are never reused");
}

#[test]
fn entries_created_with_a_new_directory_are_reported_under_a_recursive_watch() {
    let mut f = Fixture::new("fresh-directory");
    let id = f.watches.open(&f.root, true).unwrap();
    // Created before notify can add the new directory's own watch.
    fs::create_dir_all(f.root.join("routes/blog")).unwrap();
    fs::write(f.root.join("routes/index.tsx"), "1").unwrap();
    fs::write(f.root.join("routes/blog/post.tsx"), "1").unwrap();
    let seen = f.expect(id, (RENAME, Some("routes/index.tsx")));
    let seen = if seen.contains(&(RENAME, Some("routes/blog/post.tsx".into()))) {
        seen
    } else {
        f.expect(id, (RENAME, Some("routes/blog/post.tsx")))
    };
    assert!(seen.contains(&(RENAME, Some("routes".into()))), "{seen:?}");
}
