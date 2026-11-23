use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

/// Hex SHA-256 of a binary that a byte-identified package loader checks on every load.
///
/// It reads 64 KiB at a time, the largest single read Waffle serves and the chunk size
/// of its persistent storage. A reopened workspace keeps files it has not loaded in
/// IndexedDB and reads them one stored chunk per request, so 8 KiB reads fetched and
/// verified each chunk eight times (about 1,500 requests per Rolldown load).
pub(super) fn file_sha256(path: &Path) -> io::Result<String> {
    reader_sha256(File::open(path)?)
}

/// Like `io::copy`, an interrupted read is retried; every other read error is returned.
fn reader_sha256(mut reader: impl Read) -> io::Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return Ok(format!("{:x}", digest.finalize())),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        digest.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A private directory removed on drop, also when an assertion fails.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "bunwasm-binary-digest-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Yields `steps` in order, then end of file.
    struct Scripted(Vec<io::Result<Vec<u8>>>);

    impl Read for Scripted {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.0.is_empty() {
                return Ok(0);
            }
            let bytes = self.0.remove(0)?;
            buffer[..bytes.len()].copy_from_slice(&bytes);
            Ok(bytes.len())
        }
    }

    fn pattern(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index * 31 % 251) as u8).collect()
    }

    #[test]
    fn digests_files_that_span_several_reads() {
        let scratch = Scratch::new();
        let path = scratch.0.join("binary.wasm");
        for size in [0, 1, 64 * 1024, 64 * 1024 + 1, 200 * 1024 + 7] {
            let bytes = pattern(size);
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                file_sha256(&path).unwrap(),
                format!("{:x}", Sha256::digest(&bytes))
            );
        }
        assert!(file_sha256(&scratch.0.join("missing.wasm")).is_err());
    }

    #[test]
    fn retries_interrupted_reads() {
        let interrupted = || Err(io::Error::from(io::ErrorKind::Interrupted));
        let reader = Scripted(vec![
            interrupted(),
            Ok(pattern(5)),
            interrupted(),
            Ok(pattern(3)),
        ]);
        let mut expected = pattern(5);
        expected.extend(pattern(3));
        assert_eq!(
            reader_sha256(reader).unwrap(),
            format!("{:x}", Sha256::digest(&expected))
        );
    }

    #[test]
    fn returns_other_read_errors() {
        let reader = Scripted(vec![Ok(pattern(5)), Err(io::Error::from_raw_os_error(5))]);
        let error = reader_sha256(reader).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(5));
    }
}
