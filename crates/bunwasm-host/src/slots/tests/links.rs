//! Symlinks resolve in the guest namespace: absolute targets begin at guest `/`, and no link
//! or `..` reaches a host path outside the preopens (`process/wasi/links.rs`).
use super::{Fixture, Scratch};
use std::fs;
use std::path::Path;

const NOENT: i32 = 44;
const LOOP: i32 = 32;
const PREVIEW1: &str = "wasi_snapshot_preview1";
/// preview1 filetypes.
const DIRECTORY: u8 = 3;
const REGULAR: u8 = 4;
const SYMLINK: u8 = 7;

/// A preopen `root` (guest `/`) beside a host file the guest must never reach.
fn scratch(name: &str) -> (Scratch, std::path::PathBuf) {
    let parent = std::env::temp_dir().join(format!("bun-wasm-links-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&parent);
    let root = parent.join("root");
    fs::create_dir_all(root.join("tmp/d")).unwrap();
    fs::write(root.join("tmp/d/a.txt"), "inside").unwrap();
    fs::write(parent.join("outside.txt"), "outside").unwrap();
    (Scratch(parent), root)
}

fn fixtures(root: &Path) -> [Fixture; 2] {
    [Fixture::at(root), Fixture::with_memory(root, true)]
}

fn put(f: &mut Fixture, at: usize, text: &str) -> (i32, i32) {
    f.write(at, text.as_bytes());
    (at as i32, text.len() as i32)
}

fn symlink(f: &mut Fixture, target: &str, fd: i32, path: &str) -> i32 {
    let (target, target_length) = put(f, 1024, target);
    let (path, length) = put(f, 1536, path);
    f.call(
        PREVIEW1,
        "path_symlink",
        (target, target_length, fd, path, length),
    )
}

fn readlink(f: &mut Fixture, fd: i32, path: &str) -> Result<String, i32> {
    let (path, length) = put(f, 1024, path);
    match f.call(
        PREVIEW1,
        "path_readlink",
        (fd, path, length, 2048, 256, 128),
    ) {
        0 => Ok(String::from_utf8(f.bytes(2048, f.word(128) as usize)).unwrap()),
        errno => Err(errno),
    }
}

/// (filetype, size) of `path`, following a final link when `follow` is set.
fn stat(f: &mut Fixture, fd: i32, follow: bool, path: &str) -> Result<(u8, u64), i32> {
    let (path, length) = put(f, 1024, path);
    match f.call(
        PREVIEW1,
        "path_filestat_get",
        (fd, follow as i32, path, length, 2048),
    ) {
        0 => Ok((
            f.bytes(2064, 1)[0],
            u64::from_le_bytes(f.bytes(2080, 8).try_into().unwrap()),
        )),
        errno => Err(errno),
    }
}

fn open(f: &mut Fixture, fd: i32, follow: bool, path: &str, oflags: i32) -> Result<i32, i32> {
    let (path, length) = put(f, 1024, path);
    let args = (fd, follow as i32, path, length, oflags, 2i64, 0i64, 0, 128);
    match f.call(PREVIEW1, "path_open", args) {
        0 => Ok(f.word(128)),
        errno => Err(errno),
    }
}

fn path_call(f: &mut Fixture, name: &str, fd: i32, path: &str) -> i32 {
    let (path, length) = put(f, 1024, path);
    f.call(PREVIEW1, name, (fd, path, length))
}

#[test]
fn absolute_symlinks_are_stored_as_written_and_followed_from_guest_root() {
    let (_scratch, root) = scratch("absolute");
    for mut f in fixtures(&root) {
        // fd 3 is guest `/`.
        assert_eq!(symlink(&mut f, "/tmp/d/a.txt", 3, "tmp/d/abs"), 0);
        assert_eq!(
            fs::read_link(root.join("tmp/d/abs")).unwrap(),
            Path::new("/tmp/d/a.txt")
        );
        assert_eq!(
            readlink(&mut f, 3, "tmp/d/abs").as_deref(),
            Ok("/tmp/d/a.txt")
        );
        assert_eq!(stat(&mut f, 3, false, "tmp/d/abs").unwrap().0, SYMLINK);
        assert_eq!(stat(&mut f, 3, true, "tmp/d/abs"), Ok((REGULAR, 6)));
        let file = open(&mut f, 3, true, "tmp/d/abs", 0).unwrap();
        assert_eq!(f.call(PREVIEW1, "fd_filestat_get", (file, 2048)), 0);
        assert_eq!(f.bytes(2080, 1), [6]);
        assert_eq!(f.call(PREVIEW1, "fd_close", file), 0);

        // A directory link is followed as an intermediate component by every path call.
        assert_eq!(symlink(&mut f, "/tmp/d", 3, "dirlink"), 0);
        assert_eq!(stat(&mut f, 3, false, "dirlink/a.txt"), Ok((REGULAR, 6)));
        assert_eq!(stat(&mut f, 3, false, "dirlink/").unwrap().0, DIRECTORY);
        assert_eq!(
            readlink(&mut f, 3, "dirlink/abs").as_deref(),
            Ok("/tmp/d/a.txt")
        );
        assert_eq!(symlink(&mut f, "/dirlink/a.txt", 3, "dirlink/chain"), 0);
        assert_eq!(stat(&mut f, 3, true, "tmp/d/chain"), Ok((REGULAR, 6)));
        assert_eq!(
            path_call(&mut f, "path_create_directory", 3, "dirlink/made"),
            0
        );
        assert!(root.join("tmp/d/made").is_dir());
        assert_eq!(
            path_call(&mut f, "path_remove_directory", 3, "dirlink/made"),
            0
        );
        assert_eq!(path_call(&mut f, "path_unlink_file", 3, "dirlink/chain"), 0);
        assert!(fs::symlink_metadata(root.join("tmp/d/chain")).is_err());

        // A directory opened through the link resolves `..` from where it really is.
        let directory = open(&mut f, 3, true, "dirlink", 2).unwrap();
        assert_eq!(stat(&mut f, directory, false, "a.txt"), Ok((REGULAR, 6)));
        assert_eq!(stat(&mut f, directory, true, "../d/abs"), Ok((REGULAR, 6)));
        // An absolute path ignores the directory, as with Linux `*at` calls.
        assert_eq!(
            stat(&mut f, directory, true, "/tmp/d/a.txt"),
            Ok((REGULAR, 6))
        );
        assert_eq!(f.call(PREVIEW1, "fd_close", directory), 0);

        assert_eq!(path_call(&mut f, "path_unlink_file", 3, "dirlink"), 0);
        assert_eq!(path_call(&mut f, "path_unlink_file", 3, "tmp/d/abs"), 0);
    }
}

#[test]
fn links_and_dot_dot_never_leave_the_preopens() {
    let (scratch, root) = scratch("confined");
    let outside = scratch.0.join("outside.txt");
    // Links a host program could follow out of the preopen, made by the host and the guest.
    std::os::unix::fs::symlink(&outside, root.join("host-absolute")).unwrap();
    std::os::unix::fs::symlink(&scratch.0, root.join("host-parent")).unwrap();
    for mut f in fixtures(&root) {
        for (target, link) in [
            ("../outside.txt", "up"),
            ("/../outside.txt", "absolute-up"),
            ("tmp/../../../outside.txt", "nested-up"),
            ("..", "updir"),
            ("/..", "absolute-updir"),
        ] {
            assert_eq!(symlink(&mut f, target, 3, link), 0);
            assert_eq!(readlink(&mut f, 3, link).as_deref(), Ok(target));
        }
        for path in [
            "up",
            "absolute-up",
            "nested-up",
            "updir/outside.txt",
            "absolute-updir/outside.txt",
            "host-absolute",
            "host-parent/outside.txt",
            "../outside.txt",
            "tmp/../../outside.txt",
        ] {
            assert_eq!(stat(&mut f, 3, true, path), Err(NOENT), "{path}");
            assert_eq!(open(&mut f, 3, true, path, 0), Err(NOENT), "{path}");
        }
        // Calls that change the filesystem through a climbing link land at guest `/`.
        assert_eq!(
            path_call(&mut f, "path_create_directory", 3, "updir/made"),
            0
        );
        assert!(root.join("made").is_dir());
        assert!(!scratch.0.join("made").exists());
        assert_eq!(symlink(&mut f, "x", 3, "absolute-updir/placed"), 0);
        assert!(fs::symlink_metadata(root.join("placed")).is_ok());
        assert!(fs::symlink_metadata(scratch.0.join("placed")).is_err());
        assert_eq!(path_call(&mut f, "path_remove_directory", 3, "made"), 0);
        for link in [
            "up",
            "absolute-up",
            "nested-up",
            "updir",
            "absolute-updir",
            "placed",
        ] {
            assert_eq!(path_call(&mut f, "path_unlink_file", 3, link), 0);
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
    }
}

#[test]
fn absolute_link_cycles_stop_with_eloop() {
    let (_scratch, root) = scratch("loop");
    for mut f in fixtures(&root) {
        assert_eq!(symlink(&mut f, "/b", 3, "a"), 0);
        assert_eq!(symlink(&mut f, "/a", 3, "b"), 0);
        assert_eq!(stat(&mut f, 3, true, "a"), Err(LOOP));
        assert_eq!(open(&mut f, 3, true, "a/x", 0), Err(LOOP));
        assert_eq!(path_call(&mut f, "path_unlink_file", 3, "a"), 0);
        assert_eq!(path_call(&mut f, "path_unlink_file", 3, "b"), 0);
    }
}
