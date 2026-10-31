use super::*;
use std::path::PathBuf;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bun-wasm-mkdir-{}-{}",
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

#[test]
fn returns_the_first_created_directory_and_none_when_existing() {
    let fixture = Fixture::new();
    let first = fixture.path("first");
    let leaf = fixture.path("first/second/third");
    assert_eq!(mkdir_recursive(&leaf).unwrap(), Some(first));
    assert!(fs::metadata(&leaf).unwrap().is_dir());
    assert_eq!(mkdir_recursive(&leaf).unwrap(), None);
    let direct = fixture.path("direct");
    assert_eq!(mkdir_recursive(&direct).unwrap(), Some(direct));
    assert_eq!(mkdir_recursive(fixture.0.to_str().unwrap()).unwrap(), None);
}

#[test]
fn an_existing_file_is_not_an_existing_directory() {
    let fixture = Fixture::new();
    let file = fixture.path("file");
    fs::write(&file, b"keep").unwrap();
    assert_eq!(
        mkdir_recursive(&file).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(
        mkdir_recursive(&fixture.path("file/child"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotADirectory
    );
    assert_eq!(fs::read(file).unwrap(), b"keep");
}

#[cfg(unix)]
#[test]
fn follows_directory_symlinks_but_rejects_file_and_dangling_symlinks() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let directory = fixture.path("directory");
    fs::create_dir(&directory).unwrap();
    let link = fixture.path("link");
    symlink(&directory, &link).unwrap();
    assert_eq!(mkdir_recursive(&link).unwrap(), None);
    let child = fixture.path("link/child/grandchild");
    assert_eq!(
        mkdir_recursive(&child).unwrap(),
        Some(fixture.path("link/child"))
    );
    assert!(
        fs::metadata(fixture.path("directory/child/grandchild"))
            .unwrap()
            .is_dir()
    );
    let file = fixture.path("file");
    fs::write(&file, b"keep").unwrap();
    let file_link = fixture.path("file-link");
    symlink(file, &file_link).unwrap();
    assert_eq!(
        mkdir_recursive(&file_link).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    let dangling = fixture.path("dangling");
    symlink(fixture.path("missing"), &dangling).unwrap();
    assert_eq!(
        mkdir_recursive(&dangling).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert!(!fs::exists(fixture.path("missing")).unwrap());
}
