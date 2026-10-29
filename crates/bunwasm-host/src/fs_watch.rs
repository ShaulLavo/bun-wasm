//! Native `runtime_fs` guest filesystem watches over `notify` (inotify on Linux, FSEvents on
//! macOS). This is the frozen Waffle ABI (Waffle docs/host-abi.md, "Guest filesystem
//! watches"): process-local ids, whole packed records, positive WASI errnos. A delivered event
//! bumps the network notification, so a guest asleep in `Slot::Poll` wakes on the commit.
//!
//! A watch follows the node an open descriptor holds, never a saved pathname: registration
//! takes the descriptor's node identity, finds the host descriptor open on that node, and
//! watches its current path, checking the identity again once the watch exists.
use crate::net::Notify;
use notify::event::{CreateKind, EventKind, ModifyKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, VecDeque};
use std::hash::Hasher;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const ACCES: i32 = 2;
pub const AGAIN: i32 = 6;
pub const BADF: i32 = 8;
pub const FAULT: i32 = 21;
pub const INVAL: i32 = 28;
pub const NOBUFS: i32 = 42;
pub const NOENT: i32 = 44;
pub const NOTSUP: i32 = 58;

const CHANGE: u8 = 1;
const RENAME: u8 = 2;
const OVERFLOW: u8 = 3;
const NULL_NAME: u32 = u32::MAX;
/// Records a watch holds before it overflows, as in Waffle's service.
const QUEUE: usize = 128;
/// Raw notifications buffered between guest reads before the watch overflows.
const INBOX: usize = 4096;
/// 4,096 UTF-16 units at no more than 3 UTF-8 bytes each.
const NAME_BYTES: usize = 12_288;

#[derive(Default)]
struct Inbox {
    events: Vec<notify::Result<Event>>,
    overflowed: bool,
}

struct Watch {
    _watcher: RecommendedWatcher,
    root: PathBuf,
    directory: bool,
    recursive: bool,
    inbox: Arc<Mutex<Inbox>>,
    queue: VecDeque<Vec<u8>>,
    ended: bool,
}

/// One `watch_read`: whole records (empty at end of stream), the size of a first record that
/// does not fit, or an errno.
#[derive(Debug, PartialEq)]
pub enum Read {
    Records(Vec<u8>),
    Short(u32),
    Errno(i32),
}

pub struct Watches {
    notify: Arc<Notify>,
    next: u32,
    open: HashMap<u32, Watch>,
}

impl Watches {
    pub fn new(notify: Arc<Notify>) -> Self {
        Self {
            notify,
            next: 1,
            open: HashMap::new(),
        }
    }

    /// Watch the node with this identity ([`node_identity`]), which an open descriptor holds.
    pub fn open(&mut self, node: u64, recursive: bool) -> Result<u32, i32> {
        let root = node_path(node)?;
        let directory = root.metadata().map_err(io_errno)?.is_dir();
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let (sink, notify) = (inbox.clone(), self.notify.clone());
        let mut watcher = notify::recommended_watcher(move |event| {
            deliver(&sink, event);
            notify.bump();
        })
        .map_err(watch_errno)?;
        let mode = if directory && recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        watcher.watch(&root, mode).map_err(watch_errno)?;
        // The path could have been renamed or replaced since it was found.
        if path_identity(&root) != Some(node) {
            return Err(NOENT);
        }
        let id = self.next;
        self.next += 1;
        self.open.insert(
            id,
            Watch {
                _watcher: watcher,
                root,
                directory,
                recursive: directory && recursive,
                inbox,
                queue: VecDeque::new(),
                ended: false,
            },
        );
        Ok(id)
    }

    pub fn read(&mut self, id: u32, capacity: usize) -> Read {
        let Some(watch) = self.open.get_mut(&id) else {
            return Read::Errno(BADF);
        };
        watch.read(capacity)
    }

    pub fn close(&mut self, id: u32) -> i32 {
        if self.open.remove(&id).is_some() {
            0
        } else {
            BADF
        }
    }
}

fn deliver(inbox: &Mutex<Inbox>, event: notify::Result<Event>) {
    let mut inbox = inbox.lock().unwrap();
    if inbox.overflowed {
        return;
    }
    if inbox.events.len() >= INBOX {
        inbox.events.clear();
        inbox.overflowed = true;
        return;
    }
    inbox.events.push(event);
}

impl Watch {
    fn read(&mut self, capacity: usize) -> Read {
        if self.ended {
            return Read::Records(Vec::new());
        }
        if self.queue.is_empty() {
            self.drain();
        }
        let Some(first) = self.queue.front() else {
            return Read::Errno(AGAIN);
        };
        if first.len() > capacity {
            return Read::Short(first.len() as u32);
        }
        let mut out = Vec::new();
        while let Some(record) = self.queue.front() {
            if out.len() + record.len() > capacity {
                break;
            }
            self.ended = record[0] == OVERFLOW;
            out.extend_from_slice(&self.queue.pop_front().unwrap());
        }
        Read::Records(out)
    }

    /// Move buffered notifications into encoded records, coalescing an identical record that is
    /// still queued. Lost or unrepresentable information becomes a terminal overflow.
    fn drain(&mut self) {
        let Inbox { events, overflowed } = std::mem::take(&mut *self.inbox.lock().unwrap());
        if overflowed {
            return self.overflow();
        }
        for event in events {
            if !self.add(event) {
                return self.overflow();
            }
        }
    }

    fn add(&mut self, event: notify::Result<Event>) -> bool {
        let Ok(event) = event else { return false };
        if event.need_rescan() {
            return false;
        }
        let Some(kind) = record_type(&event.kind) else {
            return true;
        };
        let created_directory = matches!(event.kind, EventKind::Create(CreateKind::Folder));
        for path in &event.paths {
            if !self.push(kind, path) {
                return false;
            }
            if self.recursive && created_directory && !self.scan(path) {
                return false;
            }
        }
        true
    }

    /// Queue one record unless an identical one is still unread. False when it can't be kept.
    fn push(&mut self, kind: u8, path: &Path) -> bool {
        let Some(name) = self.name(path) else {
            return true;
        };
        let Ok(record) = encode(kind, name) else {
            return false;
        };
        if self.queue.contains(&record) {
            return true;
        }
        if self.queue.len() == QUEUE {
            return false;
        }
        self.queue.push_back(record);
        true
    }

    /// `notify` watches a new directory only after reporting it, and never reports what was
    /// already inside. Report those entries as renames, as Node's recursive watcher does.
    fn scan(&mut self, directory: &Path) -> bool {
        let mut pending = vec![directory.to_path_buf()];
        while let Some(next) = pending.pop() {
            let entries = std::fs::read_dir(&next).into_iter().flatten().flatten();
            if !entries
                .into_iter()
                .all(|entry| self.push_entry(entry, &mut pending))
            {
                return false;
            }
        }
        true
    }

    fn push_entry(&mut self, entry: std::fs::DirEntry, pending: &mut Vec<PathBuf>) -> bool {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            pending.push(path.clone());
        }
        self.push(RENAME, &path)
    }

    /// The reported name: `Some(None)` for the watched node itself, `None` to skip the path.
    fn name<'a>(&self, path: &'a Path) -> Option<Option<&'a Path>> {
        if !self.directory {
            return Some(None);
        }
        let relative = path.strip_prefix(&self.root).ok()?;
        if relative.as_os_str().is_empty() {
            return Some(None);
        }
        if !self.recursive && relative.components().count() > 1 {
            return None;
        }
        Some(Some(relative))
    }

    fn overflow(&mut self) {
        self.queue.clear();
        self.queue.push_back(encode(OVERFLOW, None).unwrap());
    }
}

fn record_type(kind: &EventKind) -> Option<u8> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => {
            Some(RENAME)
        }
        EventKind::Modify(_) | EventKind::Any | EventKind::Other => Some(CHANGE),
    }
}

/// `u8 type, 3 zero bytes, u32 LE name length (0xffffffff = null), UTF-8 name, zero padding to 4`.
fn encode(kind: u8, name: Option<&Path>) -> Result<Vec<u8>, ()> {
    let Some(name) = name else {
        let mut record = vec![kind, 0, 0, 0];
        record.extend_from_slice(&NULL_NAME.to_le_bytes());
        return Ok(record);
    };
    let name = name.to_str().ok_or(())?.as_bytes();
    if name.len() > NAME_BYTES {
        return Err(());
    }
    let mut record = vec![kind, 0, 0, 0];
    record.extend_from_slice(&(name.len() as u32).to_le_bytes());
    record.extend_from_slice(name);
    record.resize(8 + name.len().next_multiple_of(4), 0);
    Ok(record)
}

/// A node's identity as wasmtime-wasi's preview1 `filestat.ino` reports it: `DefaultHasher`
/// over the device then the inode (wasmtime-wasi `MetadataHashValue::from`). Both sides are
/// compiled into this binary, so a descriptor's `ino` and a host file's identity agree.
pub fn node_identity(metadata: &std::fs::Metadata) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write_u64(metadata.dev());
    hasher.write_u64(metadata.ino());
    hasher.finish()
}

fn path_identity(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .map(|metadata| node_identity(&metadata))
}

/// The current path of the node a host descriptor of this process holds. An unlinked node has
/// no path and reports ENOENT, as Waffle does for a detached node.
#[cfg(target_os = "linux")]
fn node_path(node: u64) -> Result<PathBuf, i32> {
    let descriptors = std::fs::read_dir("/proc/self/fd").map_err(io_errno)?;
    descriptors
        .flatten()
        .filter(|entry| path_identity(&entry.path()) == Some(node))
        .find_map(|entry| {
            std::fs::read_link(entry.path())
                .ok()
                .filter(|path| path_identity(path) == Some(node))
        })
        .ok_or(NOENT)
}

#[cfg(target_os = "macos")]
fn node_path(node: u64) -> Result<PathBuf, i32> {
    // SAFETY: getdtablesize has no preconditions.
    let limit = unsafe { libc::getdtablesize() };
    (0..limit)
        .find_map(|fd| descriptor_path(fd).filter(|path| path_identity(path) == Some(node)))
        .ok_or(NOENT)
}

#[cfg(target_os = "macos")]
fn descriptor_path(fd: i32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = [0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes into the buffer; a closed fd fails.
    if unsafe { libc::fcntl(fd, libc::F_GETPATH, buffer.as_mut_ptr()) } != 0 {
        return None;
    }
    let length = buffer.iter().position(|&byte| byte == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(
        &buffer[..length],
    )))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn node_path(_: u64) -> Result<PathBuf, i32> {
    Err(NOTSUP)
}

fn io_errno(error: std::io::Error) -> i32 {
    match error.kind() {
        std::io::ErrorKind::NotFound => NOENT,
        std::io::ErrorKind::PermissionDenied => ACCES,
        _ => NOTSUP,
    }
}

fn watch_errno(error: notify::Error) -> i32 {
    match error.kind {
        notify::ErrorKind::PathNotFound => NOENT,
        notify::ErrorKind::MaxFilesWatch => AGAIN,
        notify::ErrorKind::Io(error) => io_errno(error),
        _ => NOTSUP,
    }
}

#[cfg(test)]
mod tests;
