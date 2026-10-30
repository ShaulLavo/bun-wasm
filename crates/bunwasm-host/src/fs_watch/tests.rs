use super::*;
use crate::net::Net;
use std::fs;

/// A scratch directory removed on drop, and a watch table wired to a real network poll.
struct Fixture {
    root: PathBuf,
    net: Net,
    watches: Watches,
    /// Host descriptors standing in for the guest's: a watch names the node one of them holds.
    held: Vec<fs::File>,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("bun-wasm-fs-watch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).unwrap();
        let net = Net::new();
        let watches = Watches::new(net.notify());
        Self {
            root,
            net,
            watches,
            held: Vec::new(),
        }
    }
    /// Open `path` like a guest descriptor and watch the node it holds.
    fn watch(&mut self, path: &Path, recursive: bool) -> Result<u32, i32> {
        let file = fs::File::open(path).unwrap();
        let node = node_identity(&file.metadata().unwrap());
        self.held.push(file);
        self.watches.open(node, recursive)
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
    /// Wait, without reading, until the backend has delivered an event matching `last` into
    /// the watch's inbox; the wake and the 5 s bound are `expect`'s.
    fn delivered(&mut self, id: u32, last: impl Fn(&EventKind) -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let inbox = self.watches.open[&id].inbox.lock().unwrap();
            if inbox.events.iter().flatten().any(|event| last(&event.kind)) {
                return;
            }
            drop(inbox);
            assert!(
                std::time::Instant::now() < deadline,
                "no delivery matched in 5 s"
            );
            self.net.poll(1000);
        }
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
    let id = f.watch(&f.root.clone(), false).unwrap();
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
    let direct = f.watch(&f.root.clone(), false).unwrap();
    let recursive = f.watch(&f.root.clone(), true).unwrap();
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
    let id = f.watch(&file, true).unwrap();
    fs::write(&file, "b").unwrap();
    f.expect(id, (CHANGE, None));
}

#[test]
fn a_record_that_does_not_fit_reports_its_size_and_consumes_nothing() {
    let mut f = Fixture::new("nobufs");
    let id = f.watch(&f.root.clone(), false).unwrap();
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
    let id = f.watch(&f.root.clone(), false).unwrap();
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
    let id = f.watch(&file, false).unwrap();
    for value in 1..20 {
        fs::write(&file, value.to_string()).unwrap();
    }
    // Coalescing joins records that are still unread; one read between two deliveries yields
    // two. notify delivers one watch's events in kernel order on one thread, so the rename's
    // delivery follows every write's, and reading only after it leaves them unread together.
    fs::rename(&file, f.root.join("moved.txt")).unwrap();
    f.delivered(id, |kind| {
        matches!(kind, EventKind::Modify(ModifyKind::Name(_)))
    });
    assert_eq!(f.drain(id), [(CHANGE, None), (RENAME, None)]);
}

#[test]
fn ids_close_once_and_missing_nodes_fail_registration() {
    let mut f = Fixture::new("close");
    // A node that no descriptor holds has no path to watch.
    let loose = f.root.join("loose.txt");
    fs::write(&loose, "x").unwrap();
    assert_eq!(
        f.watches
            .open(node_identity(&loose.metadata().unwrap()), false),
        Err(NOENT)
    );
    let first = f.watch(&f.root.clone(), false).unwrap();
    let second = f.watch(&f.root.clone(), false).unwrap();
    assert_ne!(first, second);
    assert_eq!(f.watches.close(first), 0);
    assert_eq!(f.watches.close(first), BADF);
    assert_eq!(f.watches.read(first, 4096), Read::Errno(BADF));
    let third = f.watch(&f.root.clone(), false).unwrap();
    assert!(third > second, "ids are never reused");
}

#[test]
fn entries_created_with_a_new_directory_are_reported_under_a_recursive_watch() {
    let mut f = Fixture::new("fresh-directory");
    let id = f.watch(&f.root.clone(), true).unwrap();
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

#[test]
fn a_watch_follows_the_held_node_through_rename_and_replacement() {
    let mut f = Fixture::new("held-node");
    let path = f.root.join("page.tsx");
    let moved = f.root.join("moved.tsx");
    fs::write(&path, "original").unwrap();
    let held = fs::File::open(&path).unwrap();
    let node = node_identity(&held.metadata().unwrap());
    fs::rename(&path, &moved).unwrap();
    fs::write(&path, "replacement").unwrap();
    assert_ne!(node_identity(&path.metadata().unwrap()), node);
    f.held.push(held);
    let id = f.watches.open(node, false).unwrap();
    let registered = inotify_inodes();
    assert!(
        registered.contains(&moved.metadata().unwrap().ino()),
        "{registered:?}"
    );
    assert!(
        !registered.contains(&path.metadata().unwrap().ino()),
        "{registered:?}"
    );
    fs::write(&path, "replacement changed").unwrap();
    f.net.poll(300);
    assert_eq!(
        f.drain(id),
        Vec::new(),
        "the replacement is a different node"
    );
    fs::write(&moved, "original changed").unwrap();
    f.expect(id, (CHANGE, None));
}

#[test]
fn an_unlinked_held_node_reports_enoent() {
    let mut f = Fixture::new("unlinked");
    let path = f.root.join("gone.txt");
    fs::write(&path, "x").unwrap();
    let held = fs::File::open(&path).unwrap();
    let node = node_identity(&held.metadata().unwrap());
    fs::remove_file(&path).unwrap();
    f.held.push(held);
    assert_eq!(f.watches.open(node, false), Err(NOENT));
}

/// The inodes the kernel has registered for every inotify watch of this process, read from
/// `/proc/self/fdinfo` (`inotify wd:… ino:<hex> sdev:…`). This is what the backend watches,
/// independent of any path the host resolved.
#[cfg(target_os = "linux")]
fn inotify_inodes() -> Vec<u64> {
    let entries = fs::read_dir("/proc/self/fdinfo").unwrap().flatten();
    let texts = entries.filter_map(|entry| fs::read_to_string(entry.path()).ok());
    texts
        .flat_map(|text| text.lines().filter_map(watched_inode).collect::<Vec<_>>())
        .collect()
}

#[cfg(target_os = "linux")]
fn watched_inode(line: &str) -> Option<u64> {
    let field = line
        .strip_prefix("inotify wd:")?
        .split_whitespace()
        .find(|field| field.starts_with("ino:"))?;
    u64::from_str_radix(&field["ino:".len()..], 16).ok()
}

#[cfg(target_os = "linux")]
#[test]
fn registration_binds_the_held_inode_while_its_name_names_another_file() {
    let mut f = Fixture::new("swap-boundary");
    let name = f.root.join("page.tsx");
    let aside = f.root.join("page.aside");
    fs::write(&name, "held").unwrap();
    let held = fs::File::open(&name).unwrap();
    let held_inode = held.metadata().unwrap().ino();
    let node = node_identity(&held.metadata().unwrap());
    f.held.push(held);
    // A→B: at registration the held node's name names a different file.
    fs::rename(&name, &aside).unwrap();
    fs::write(&name, "other").unwrap();
    let other_inode = name.metadata().unwrap().ino();
    let id = f.watches.open(node, false).unwrap();
    // B→A: swap the names back after registration; a path-based check would now pass either way.
    fs::rename(&name, f.root.join("other.tsx")).unwrap();
    fs::rename(&aside, &name).unwrap();
    let registered = inotify_inodes();
    assert!(registered.contains(&held_inode), "{registered:?}");
    assert!(!registered.contains(&other_inode), "{registered:?}");
    // Renaming the held file back is itself a rename of the watched node.
    f.expect(id, (RENAME, None));
    f.drain(id);
    fs::write(f.root.join("other.tsx"), "other changed").unwrap();
    f.net.poll(300);
    assert_eq!(
        f.drain(id),
        Vec::new(),
        "the other file is not the held node"
    );
    fs::write(&name, "held changed").unwrap();
    f.expect(id, (CHANGE, None));
}

#[test]
fn a_watch_keeps_its_node_after_every_other_descriptor_closes() {
    let mut f = Fixture::new("own-descriptor");
    let id = f.watch(&f.root.clone(), true).unwrap();
    f.held.clear();
    fs::create_dir(f.root.join("later")).unwrap();
    fs::write(f.root.join("later/file.txt"), "x").unwrap();
    f.expect(id, (RENAME, Some("later/file.txt")));
}

/// Register `path` with a real `notify` backend while `swap` runs between resolving and
/// registering, then report which inodes the kernel registered.
#[cfg(target_os = "linux")]
fn registered_after_swap(path: &Path, swap: impl FnOnce()) -> (RecommendedWatcher, Vec<u64>) {
    let mut watcher = notify::recommended_watcher(|_: notify::Result<Event>| {}).unwrap();
    swap();
    watcher.watch(path, RecursiveMode::NonRecursive).unwrap();
    (watcher, inotify_inodes())
}

#[cfg(target_os = "linux")]
#[test]
fn a_name_swapped_at_the_registration_boundary_cannot_redirect_the_descriptor_link() {
    let f = Fixture::new("boundary-link");
    let name = f.root.join("page.tsx");
    let aside = f.root.join("page.aside");
    fs::write(&name, "held").unwrap();
    let held = fs::File::open(&name).unwrap();
    let node = node_identity(&held.metadata().unwrap());
    let held_inode = held.metadata().unwrap().ino();
    fs::write(&aside, "other").unwrap();
    let other_inode = aside.metadata().unwrap().ino();
    let swap = || {
        fs::rename(&name, f.root.join("tmp")).unwrap();
        fs::rename(&aside, &name).unwrap();
    };
    let restore = || {
        fs::rename(&name, &aside).unwrap();
        fs::rename(f.root.join("tmp"), &name).unwrap();
    };
    // The old binding: resolve the descriptor's current name, then register that name. A swap
    // between the two steps registers the other file, and swapping back hides it from a check.
    let resolved = fs::read_link(format!("/proc/self/fd/{}", held.as_raw_fd())).unwrap();
    let (by_name, registered) = registered_after_swap(&resolved, swap);
    restore();
    assert_eq!(
        node_identity(&resolved.metadata().unwrap()),
        node,
        "a path check passes"
    );
    assert!(registered.contains(&other_inode), "{registered:?}");
    assert!(!registered.contains(&held_inode), "{registered:?}");
    drop(by_name);
    // The binding: the duplicated descriptor's link resolves to the held inode under the same swap.
    let (descriptor, _) = node_descriptor(node).unwrap();
    let root = descriptor_root(&descriptor).unwrap();
    let (_by_descriptor, registered) = registered_after_swap(&root, swap);
    restore();
    assert!(registered.contains(&held_inode), "{registered:?}");
    assert!(!registered.contains(&other_inode), "{registered:?}");
}
