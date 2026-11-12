use super::*;
use std::{
    ffi::CString,
    fs::{self, File},
    io::{ErrorKind, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    directory: PathBuf,
    events: File,
}

impl Fixture {
    fn new() -> Self {
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        assert!(fd >= 0, "{}", std::io::Error::last_os_error());
        let fixture = Self {
            directory: std::env::temp_dir().join(format!(
                "bun-wasm-local-lookahead-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )),
            events: unsafe { File::from_raw_fd(fd) },
        };
        fs::create_dir(&fixture.directory).unwrap();
        fixture
    }

    fn package(&self, name: &str, dependencies: Value) -> String {
        let path = self.directory.join(name);
        fs::create_dir(&path).unwrap();
        let manifest = path.join("package.json");
        fs::write(
            &manifest,
            serde_json::to_vec(&json!({
                "name": name, "version": "1.0.0", "dependencies": dependencies
            }))
            .unwrap(),
        )
        .unwrap();
        let watched = CString::new(manifest.as_os_str().as_bytes()).unwrap();
        let watch = unsafe {
            libc::inotify_add_watch(self.events.as_raw_fd(), watched.as_ptr(), libc::IN_OPEN)
        };
        assert!(watch >= 0, "{}", std::io::Error::last_os_error());
        format!("file:{}", path.display())
    }

    fn dependencies(&self, prefix: &str, count: usize) -> Value {
        let mut dependencies = serde_json::Map::new();
        for index in 0..count {
            let name = format!("{prefix}-{index:04}");
            dependencies.insert(name.clone(), self.package(&name, json!({})).into());
        }
        dependencies.into()
    }

    fn opens(&mut self) -> usize {
        let mut buffer = [0; 65536];
        let mut opens = 0;
        loop {
            match self.events.read(&mut buffer) {
                Ok(0) => return opens,
                Ok(bytes) => opens += count_opens(&buffer[..bytes]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => return opens,
                Err(error) => panic!("inotify read failed: {error}"),
            }
        }
    }

    fn observe(&mut self, manifest: &Value) -> usize {
        let control = fs::read(self.directory.join("control/package.json")).unwrap();
        assert!(!control.is_empty());
        assert_eq!(self.opens(), 1, "file-open observer did not arm");
        let mut resolver = Resolver::new(
            io::Registry::new("http://registry.invalid").unwrap(),
            json!({}),
            false,
        );
        resolver.resolve(manifest, false).unwrap();
        self.opens()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn count_opens(bytes: &[u8]) -> usize {
    let mut offset = 0;
    let mut opens = 0;
    while offset + 16 <= bytes.len() {
        let mask = u32::from_ne_bytes(bytes[offset + 4..offset + 8].try_into().unwrap());
        let length = u32::from_ne_bytes(bytes[offset + 12..offset + 16].try_into().unwrap());
        assert_eq!(
            mask & libc::IN_Q_OVERFLOW,
            0,
            "file-open observer overflowed"
        );
        opens += usize::from(mask & libc::IN_OPEN != 0);
        offset += 16 + length as usize;
    }
    assert_eq!(offset, bytes.len());
    opens
}

#[test]
fn local_lookahead_opens_scale_linearly() {
    for count in [64, 128] {
        let mut fixture = Fixture::new();
        fixture.package("control", json!({}));
        let dependencies = fixture.dependencies("item", count);
        let opens = fixture.observe(&json!({"dependencies": dependencies}));
        println!("root local edges={count}, manifest opens={opens}");
        assert!(opens <= count * 4, "{opens} opens for {count} local edges");
    }
}

#[test]
fn pending_local_parents_do_not_rescan_manifests() {
    for count in [32, 64] {
        let mut fixture = Fixture::new();
        fixture.package("control", json!({}));
        let first = fixture.dependencies("first", count);
        let second = fixture.dependencies("second", count);
        let manifest = json!({"dependencies": {
            "a-parent": fixture.package("a-parent", first),
            "b-parent": fixture.package("b-parent", second)
        }});
        let opens = fixture.observe(&manifest);
        println!("queued local edges={}, manifest opens={opens}", count * 2);
        assert!(
            opens <= count * 8 + 16,
            "{opens} opens for two parents of {count} edges"
        );
    }
}
