mod extraction;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

static DIRECTORIES: AtomicUsize = AtomicUsize::new(0);

fn create_dir_all(path: impl AsRef<Path>) -> std::io::Result<()> {
    DIRECTORIES.fetch_add(1, Ordering::Relaxed);
    fs::create_dir_all(path)
}

fn archive(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    for (name, kind, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(*kind);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        tar.append(&header, *bytes).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn repeated_parents(root: &Path) {
    let file = tar::EntryType::Regular;
    let bytes = archive(&[
        ("package/a/first", file, b"first"),
        ("package/b/empty", file, b""),
        ("package/a/last", file, b"last"),
        ("package/a/first", file, b"replacement"),
        ("package/a", tar::EntryType::Directory, b""),
    ]);
    DIRECTORIES.store(0, Ordering::Relaxed);
    extraction::extract(&bytes, root).unwrap();
    assert_eq!(DIRECTORIES.load(Ordering::Relaxed), 3);
    assert_eq!(fs::read(root.join("a/first")).unwrap(), b"replacement");
    assert_eq!(fs::read(root.join("a/last")).unwrap(), b"last");
    assert!(fs::read(root.join("b/empty")).unwrap().is_empty());
    let manifest = archive(&[("package/package.json", file, b"{\"name\":\"fixture\"}")]);
    assert_eq!(
        extraction::archive_manifest(&manifest).unwrap()["name"],
        "fixture"
    );
}

fn saturated_cache(root: &Path) {
    let names: Vec<String> = (0..1100)
        .map(|index| format!("package/d{index}/file"))
        .collect();
    let entries: Vec<_> = names
        .iter()
        .cycle()
        .take(names.len() * 2)
        .map(|name| {
            (
                name.as_str(),
                tar::EntryType::Regular,
                b"contents".as_slice(),
            )
        })
        .collect();
    DIRECTORIES.store(0, Ordering::Relaxed);
    extraction::extract(&archive(&entries), root).unwrap();
    assert_eq!(DIRECTORIES.load(Ordering::Relaxed), 1176);
    for index in 0..1100 {
        assert_eq!(
            fs::read(root.join(format!("d{index}/file"))).unwrap(),
            b"contents"
        );
    }
}

fn invalid_entries(root: &Path) {
    for kind in [tar::EntryType::Symlink, tar::EntryType::Link] {
        let error =
            extraction::extract(&archive(&[("package/link", kind, b"")]), root).unwrap_err();
        assert!(error.contains("Unsupported tarball entry"), "{error}");
    }
    let unsafe_path = archive(&[("package/../../escape", tar::EntryType::Regular, b"bad")]);
    assert_eq!(
        extraction::extract(&unsafe_path, root).unwrap_err(),
        "Unsafe tarball path"
    );
    let conflict = archive(&[
        ("package/file", tar::EntryType::Regular, b"file"),
        ("package/file/child", tar::EntryType::Regular, b"child"),
    ]);
    let error = extraction::extract(&conflict, root).unwrap_err();
    let expected = fs::create_dir_all(root.join("file"))
        .unwrap_err()
        .to_string();
    assert_eq!(error, expected);
    assert_eq!(fs::read(root.join("file")).unwrap(), b"file");
    assert!(extraction::extract(b"invalid gzip", root).is_err());
}

fn oversized_entry(root: &Path) {
    use std::io::Write;
    let mut header = tar::Header::new_gnu();
    header.set_path("package/large").unwrap();
    header.set_size(256 * 1024 * 1024 + 1);
    header.set_cksum();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(header.as_bytes()).unwrap();
    assert_eq!(
        extraction::extract(&encoder.finish().unwrap(), root).unwrap_err(),
        "Extracted package exceeds 256 MiB"
    );
    assert!(!root.join("large").exists());
}

#[cfg(unix)]
fn existing_modes_and_links(root: &Path) {
    use std::os::unix::fs::{PermissionsExt, symlink};
    fs::create_dir_all(root).unwrap();
    let target = root.join("target");
    fs::write(&target, b"old").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&target, root.join("hard")).unwrap();
    symlink("target", root.join("symbolic")).unwrap();
    let bytes = archive(&[
        ("package/hard", tar::EntryType::Regular, b"via hard link"),
        ("package/symbolic", tar::EntryType::Regular, b"via symlink"),
    ]);
    extraction::extract(&bytes, root).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"via symlink");
    assert_eq!(fs::read(root.join("hard")).unwrap(), b"via symlink");
    assert_eq!(
        fs::read_link(root.join("symbolic")).unwrap(),
        Path::new("target")
    );
    assert_eq!(
        fs::metadata(target).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

fn main() {
    let root = std::path::PathBuf::from(std::env::args_os().nth(1).unwrap());
    repeated_parents(&root.join("repeated"));
    saturated_cache(&root.join("saturated"));
    invalid_entries(&root.join("invalid"));
    oversized_entry(&root.join("oversized"));
    #[cfg(unix)]
    existing_modes_and_links(&root.join("links"));
}
