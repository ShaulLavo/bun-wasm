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
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(format!("{:x}", digest.finalize()));
        }
        digest.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_files_that_span_several_reads() {
        let path =
            std::env::temp_dir().join(format!("bunwasm-binary-digest-{}", std::process::id()));
        for size in [0, 1, 64 * 1024, 64 * 1024 + 1, 200 * 1024 + 7] {
            let bytes: Vec<u8> = (0..size).map(|index| (index * 31 % 251) as u8).collect();
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                file_sha256(&path).unwrap(),
                format!("{:x}", Sha256::digest(&bytes))
            );
        }
        std::fs::remove_file(&path).unwrap();
        assert!(file_sha256(&path).is_err());
    }
}
