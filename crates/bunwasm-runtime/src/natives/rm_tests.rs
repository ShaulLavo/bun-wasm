use super::*;
use std::path::PathBuf;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bun-wasm-rm-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().to_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn rm(path: &str, recursive: bool, force: bool) -> NativeResult {
    let mut table = Table::default();
    install_fs(&mut table);
    let (_, function) = table
        .functions
        .iter()
        .find(|(name, _)| *name == "rm")
        .expect("registered rm native");
    function(Args(&[path.into(), recursive.into(), force.into()]))
}

fn assert_error(error: NativeError, code: &str, errno: i32, path: &str) {
    assert!(error.props.contains(&("code".into(), code.into())));
    assert!(error.props.contains(&("errno".into(), errno.into())));
    assert!(error.props.contains(&("syscall".into(), "rm".into())));
    assert!(error.props.contains(&("path".into(), path.into())));
}

#[cfg(unix)]
#[test]
fn force_preserves_intermediate_symlink_loop_errors() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink("cycle", fixture.path("cycle")).unwrap();
    let path = fixture.path("cycle/entry");
    for force in [false, true] {
        let error =
            rm(&path, false, force).expect_err(&format!("force={force} must preserve ELOOP"));
        assert_error(error, "ELOOP", -40, &path);
    }
}

#[test]
fn force_only_ignores_missing_targets() {
    let fixture = Fixture::new();
    let path = fixture.path("missing");
    assert_error(rm(&path, false, false).unwrap_err(), "ENOENT", -2, &path);
    assert_eq!(rm(&path, false, true).unwrap(), Val::Undefined);
    assert_eq!(rm(&path, true, true).unwrap(), Val::Undefined);
}

#[test]
fn removes_ordinary_files() {
    let fixture = Fixture::new();
    let path = fixture.path("file");
    for force in [false, true] {
        fs::write(&path, b"remove").unwrap();
        assert_eq!(rm(&path, false, force).unwrap(), Val::Undefined);
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
        assert_error(
            rm(&directory, false, force).unwrap_err(),
            "EISDIR",
            -21,
            &directory,
        );
        assert_eq!(fs::read(&child).unwrap(), b"keep until recursive");
    }
    assert_eq!(rm(&directory, true, true).unwrap(), Val::Undefined);
    assert!(!fs::exists(&directory).unwrap());
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
        assert_eq!(rm(&link, recursive, true).unwrap(), Val::Undefined);
        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read(fixture.path("referent/child")).unwrap(), b"keep");
    }
}
