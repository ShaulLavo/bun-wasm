use super::*;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    table: Table,
}

impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let root = std::env::temp_dir().join(format!(
            "bun-wasm-rm-{}-{}",
            std::process::id(),
            stamp.as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let mut table = Table::default();
        let state = Rc::new(State::new(
            Vec::new(),
            Box::new(crate::transpiler::PassthroughTranspiler),
        ));
        install_fs(&mut table, &state);
        Self { root, table }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_str().unwrap().to_owned()
    }

    fn rm(&self, path: &str, recursive: bool, force: bool) -> NativeResult {
        self.call("rm", &[path.into(), recursive.into(), force.into()])
    }

    fn rmdir(&self, path: &str, recursive: bool) -> NativeResult {
        self.call("rmdir", &[path.into(), recursive.into()])
    }

    fn copy_file(&self, from: &str, to: &str, flags: i32) -> NativeResult {
        self.call("copyFile", &[from.into(), to.into(), flags.into()])
    }

    fn call(&self, target: &str, args: &[Val]) -> NativeResult {
        let (_, function) = self
            .table
            .functions
            .iter()
            .find(|(name, _)| *name == target)
            .unwrap_or_else(|| panic!("registered {target} native"));
        function(Args(args))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn assert_error_syscall(error: NativeError, code: &str, errno: i32, syscall: &str, path: &str) {
    assert!(
        error.props.contains(&("code".into(), code.into())),
        "expected code {code}, got {:?}",
        error.props
    );
    assert!(
        error.props.contains(&("errno".into(), errno.into())),
        "expected errno {errno}, got {:?}",
        error.props
    );
    assert!(
        error.props.contains(&("syscall".into(), syscall.into())),
        "expected syscall {syscall}, got {:?}",
        error.props
    );
    assert!(
        error.props.contains(&("path".into(), path.into())),
        "expected path {path}, got {:?}",
        error.props
    );
}

fn assert_error(error: NativeError, code: &str, errno: i32, path: &str) {
    assert_error_syscall(error, code, errno, "rm", path);
}

#[cfg(unix)]
#[test]
fn force_preserves_intermediate_symlink_loop_errors() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink("cycle", fixture.path("cycle")).unwrap();
    let path = fixture.path("cycle/entry");
    for force in [false, true] {
        let error = fixture
            .rm(&path, false, force)
            .expect_err(&format!("force={force} must preserve ELOOP"));
        assert_error(error, "ELOOP", -40, &path);
    }
}

#[test]
fn force_only_ignores_missing_targets() {
    let fixture = Fixture::new();
    let path = fixture.path("missing");
    assert_error(
        fixture.rm(&path, false, false).unwrap_err(),
        "ENOENT",
        -2,
        &path,
    );
    assert_eq!(fixture.rm(&path, false, true).unwrap(), Val::Undefined);
    assert_eq!(fixture.rm(&path, true, true).unwrap(), Val::Undefined);
}

#[test]
fn removes_ordinary_files() {
    let fixture = Fixture::new();
    let path = fixture.path("file");
    for force in [false, true] {
        fs::write(&path, b"remove").unwrap();
        assert_eq!(fixture.rm(&path, false, force).unwrap(), Val::Undefined);
        assert!(!fs::exists(&path).unwrap());
    }
}

#[test]
fn directories_require_recursive_removal_even_with_force() {
    let fixture = Fixture::new();
    let directory = fixture.path("directory");
    let child = fixture.path("directory/child");
    fs::create_dir(&directory).unwrap();
    fs::write(&child, b"keep until recursive").unwrap();
    for force in [false, true] {
        let error = fixture.rm(&directory, false, force).unwrap_err();
        assert_error(error, "ERR_FS_EISDIR", 21, &directory);
        assert_eq!(fs::read(&child).unwrap(), b"keep until recursive");
    }
    assert_eq!(fixture.rm(&directory, true, true).unwrap(), Val::Undefined);
    assert!(!fs::exists(&directory).unwrap());
}

#[test]
fn trailing_slash_removes_directory_and_rejects_file() {
    let fixture = Fixture::new();
    let directory = fixture.path("trailing-dir");
    fs::create_dir_all(format!("{directory}/sub")).unwrap();
    assert_eq!(
        fixture.rm(&format!("{directory}/"), true, false).unwrap(),
        Val::Undefined
    );
    assert!(!fs::exists(&directory).unwrap());

    let file = fixture.path("trailing-file");
    fs::write(&file, b"x").unwrap();
    let with_slash = format!("{file}/");
    assert_error(
        fixture.rm(&with_slash, true, false).unwrap_err(),
        "ENOTDIR",
        -20,
        &with_slash,
    );
}

#[cfg(unix)]
#[test]
fn removes_final_symlinks_without_removing_their_referents() {
    let fixture = Fixture::new();
    let referent = fixture.path("referent");
    fs::create_dir(&referent).unwrap();
    fs::write(fixture.path("referent/child"), b"keep").unwrap();
    let link = fixture.path("link");
    for recursive in [false, true] {
        std::os::unix::fs::symlink("referent", &link).unwrap();
        assert_eq!(fixture.rm(&link, recursive, true).unwrap(), Val::Undefined);
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(fixture.path("referent/child")).unwrap(), b"keep");
    }
}

#[cfg(unix)]
#[test]
fn trailing_slash_rejects_symlinks_without_deleting_them_or_targets() {
    let fixture = Fixture::new();
    let referent = fixture.path("referent");
    fs::create_dir(&referent).unwrap();
    fs::write(fixture.path("referent/child"), b"keep").unwrap();
    let dir_link = fixture.path("dir-link");
    std::os::unix::fs::symlink("referent", &dir_link).unwrap();
    let dir_link_slash = format!("{dir_link}/");
    for force in [false, true] {
        assert_error(
            fixture.rm(&dir_link_slash, false, force).unwrap_err(),
            "ERR_FS_EISDIR",
            21,
            &dir_link_slash,
        );
        assert_error(
            fixture.rm(&dir_link_slash, true, force).unwrap_err(),
            "ENOTDIR",
            -20,
            &dir_link_slash,
        );
        assert!(
            fs::symlink_metadata(&dir_link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(fixture.path("referent/child")).unwrap(), b"keep");
    }

    let dangling = fixture.path("dangling");
    std::os::unix::fs::symlink("missing-target", &dangling).unwrap();
    let dangling_slash = format!("{dangling}/");
    for (recursive, force) in [(false, true), (true, false), (true, true)] {
        assert_error(
            fixture.rm(&dangling_slash, recursive, force).unwrap_err(),
            "ENOTDIR",
            -20,
            &dangling_slash,
        );
        assert!(
            fs::symlink_metadata(&dangling)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}

#[cfg(unix)]
#[test]
fn rmdir_handles_trailing_slashes_symlinks_and_recursive_files() {
    let fixture = Fixture::new();
    let referent = fixture.path("referent");
    fs::create_dir(&referent).unwrap();
    fs::write(fixture.path("referent/child"), b"keep").unwrap();
    let dir_link = fixture.path("dir-link");
    std::os::unix::fs::symlink("referent", &dir_link).unwrap();
    let dir_link_slash = format!("{dir_link}/");
    assert_error_syscall(
        fixture.rmdir(&dir_link_slash, true).unwrap_err(),
        "ENOTDIR",
        -20,
        "rm",
        &dir_link_slash,
    );
    assert_error_syscall(
        fixture.rmdir(&dir_link_slash, false).unwrap_err(),
        "ENOTDIR",
        -20,
        "rmdir",
        &dir_link_slash,
    );
    assert!(
        fs::symlink_metadata(&dir_link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(fixture.path("referent/child")).unwrap(), b"keep");

    let empty = fixture.path("empty");
    fs::create_dir(&empty).unwrap();
    assert_eq!(
        fixture.rmdir(&format!("{empty}/"), false).unwrap(),
        Val::Undefined
    );
    assert!(!fs::exists(&empty).unwrap());

    let nonempty = fixture.path("nonempty");
    fs::create_dir(&nonempty).unwrap();
    fs::write(fixture.path("nonempty/child"), b"x").unwrap();
    let nonempty_slash = format!("{nonempty}/");
    assert_error_syscall(
        fixture.rmdir(&nonempty_slash, false).unwrap_err(),
        "ENOTEMPTY",
        -39,
        "rmdir",
        &nonempty_slash,
    );
    assert_eq!(
        fixture.rmdir(&nonempty_slash, true).unwrap(),
        Val::Undefined
    );
    assert!(!fs::exists(&nonempty).unwrap());

    let file = fixture.path("plain-file");
    fs::write(&file, b"hello").unwrap();
    assert_eq!(fixture.rmdir(&file, true).unwrap(), Val::Undefined);
    assert!(!fs::exists(&file).unwrap());
}

#[cfg(unix)]
#[test]
fn copy_file_preserves_contents_when_source_and_dest_are_same_file() {
    let fixture = Fixture::new();
    let file = fixture.path("same.txt");
    let hard = fixture.path("hard.txt");
    fs::write(&file, b"keep-me").unwrap();
    fs::hard_link(&file, &hard).unwrap();

    assert_eq!(fixture.copy_file(&file, &file, 0).unwrap(), Val::Undefined);
    assert_eq!(fs::read(&file).unwrap(), b"keep-me");
    assert_eq!(fixture.copy_file(&file, &hard, 0).unwrap(), Val::Undefined);
    assert_eq!(fs::read(&file).unwrap(), b"keep-me");

    let excl = fixture.copy_file(&file, &file, 1).unwrap_err();
    assert!(excl.props.contains(&("code".into(), "EEXIST".into())));
    assert_eq!(fs::read(&file).unwrap(), b"keep-me");
}
