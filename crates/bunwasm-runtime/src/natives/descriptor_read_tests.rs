use super::*;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const REQUEST: usize = 65536;

struct Fixture(PathBuf);

impl Fixture {
    fn new(bytes: &[u8]) -> Self {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let path = std::env::temp_dir().join(format!(
            "bun-wasm-descriptor-read-{}-{}",
            std::process::id(),
            stamp.as_nanos()
        ));
        fs::write(&path, bytes).unwrap();
        Self(path)
    }

    fn open(&self) -> File {
        File::open(&self.0).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_file(&self.0).unwrap();
    }
}

#[test]
fn tiny_tail_and_eof_retain_only_remaining_capacity() {
    let fixture = Fixture::new(b"abcdef");
    let mut file = fixture.open();
    file.seek(SeekFrom::Start(3)).unwrap();
    let tail = read(file.as_raw_fd(), REQUEST, None).unwrap();
    assert_eq!(tail, b"def");
    assert_eq!(tail.capacity(), 3);
    assert_eq!(file.stream_position().unwrap(), 6);
    let eof = read(file.as_raw_fd(), REQUEST, None).unwrap();
    assert!(eof.is_empty());
    assert_eq!(eof.capacity(), 0);
    println!(
        "regular tail capacity: {}; EOF capacity: {}",
        tail.capacity(),
        eof.capacity()
    );
}

#[test]
fn positioned_reads_leave_advanced_shared_cursor_unchanged() {
    let fixture = Fixture::new(b"abcdef");
    let mut file = fixture.open();
    file.seek(SeekFrom::Start(2)).unwrap();
    let tail = read(file.as_raw_fd(), REQUEST, Some(5)).unwrap();
    assert_eq!(tail, b"f");
    assert_eq!(tail.capacity(), 1);
    assert_eq!(file.stream_position().unwrap(), 2);
    let eof = read(file.as_raw_fd(), REQUEST, Some(99)).unwrap();
    assert_eq!(eof.capacity(), 0);
    assert_eq!(file.stream_position().unwrap(), 2);
    assert_eq!(read(file.as_raw_fd(), REQUEST, None).unwrap(), b"cdef");
}

#[test]
fn empty_readonly_file_and_explicit_empty_requests_validate() {
    let fixture = Fixture::new(b"");
    let file = fixture.open();
    assert_eq!(read(file.as_raw_fd(), REQUEST, None).unwrap().capacity(), 0);
    assert_eq!(
        read(file.as_raw_fd(), REQUEST, Some(0)).unwrap().capacity(),
        0
    );
    let bytes = read_with_metadata(file.as_raw_fd(), 0, None, || {
        panic!("empty read must not query metadata")
    })
    .unwrap();
    assert_eq!(bytes.capacity(), 0);
}

#[test]
fn eof_does_not_hide_invalid_or_writeonly_descriptor_errors() {
    let fixture = Fixture::new(b"");
    let writeonly = OpenOptions::new().write(true).open(&fixture.0).unwrap();
    for position in [None, Some(0)] {
        for length in [0, REQUEST] {
            assert_eq!(
                read(-1, length, position).unwrap_err().raw_os_error(),
                Some(libc::EBADF)
            );
            assert_eq!(
                read(writeonly.as_raw_fd(), length, position)
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EBADF)
            );
        }
    }
}

#[test]
fn missing_metadata_rights_preserve_full_single_read_and_errors() {
    let fixture = Fixture::new(b"abc");
    let mut file = fixture.open();
    let denied = || Err(io::Error::from(io::ErrorKind::PermissionDenied));
    let tail = read_with_metadata(file.as_raw_fd(), REQUEST, None, denied).unwrap();
    assert_eq!(tail, b"abc");
    assert_eq!(tail.capacity(), REQUEST);
    assert_eq!(file.stream_position().unwrap(), 3);
    let eof = read_with_metadata(file.as_raw_fd(), REQUEST, None, denied).unwrap();
    assert_eq!(eof.capacity(), REQUEST);
    let positioned = read_with_metadata(file.as_raw_fd(), REQUEST, Some(1), denied).unwrap();
    assert_eq!(positioned, b"bc");
    assert_eq!(positioned.capacity(), REQUEST);
    assert_eq!(file.stream_position().unwrap(), 3);
    assert_eq!(
        read_with_metadata(-1, REQUEST, None, denied)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EBADF)
    );
}

fn pipe() -> (OwnedFd, OwnedFd) {
    let mut fds = [-1; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
}

#[test]
fn pipe_zero_size_does_not_mean_eof_or_trigger_a_second_read() {
    let (reader, writer) = pipe();
    assert_eq!(
        unsafe { libc::write(writer.as_raw_fd(), b"abc".as_ptr().cast(), 3) },
        3
    );
    let bytes = read(reader.as_raw_fd(), REQUEST, None).unwrap();
    assert_eq!(bytes, b"abc");
    assert_eq!(bytes.capacity(), REQUEST);
    assert_eq!(
        read(reader.as_raw_fd(), REQUEST, Some(0))
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ESPIPE)
    );
    assert!(unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } >= 0);
    assert_eq!(
        read(reader.as_raw_fd(), REQUEST, None).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(writer);
    assert_eq!(
        read(reader.as_raw_fd(), REQUEST, None).unwrap().capacity(),
        REQUEST
    );
}

#[test]
fn unavailable_cursor_keeps_the_single_read_contract() {
    let (reader, writer) = pipe();
    assert_eq!(
        unsafe { libc::write(writer.as_raw_fd(), b"abc".as_ptr().cast(), 3) },
        3
    );
    let mut stat = metadata(reader.as_raw_fd()).unwrap();
    stat.st_mode = libc::S_IFREG;
    stat.st_size = 0;
    let bytes = read_with_metadata(reader.as_raw_fd(), REQUEST, None, || Ok(stat)).unwrap();
    assert_eq!(bytes, b"abc");
    assert_eq!(bytes.capacity(), REQUEST);
}

#[test]
fn sockets_and_devices_keep_requested_capacity() {
    let (reader, mut writer) = UnixStream::pair().unwrap();
    writer.write_all(b"abc").unwrap();
    let bytes = read(reader.as_raw_fd(), REQUEST, None).unwrap();
    assert_eq!(bytes, b"abc");
    assert_eq!(bytes.capacity(), REQUEST);
    let null = File::open("/dev/null").unwrap();
    assert_eq!(
        read(null.as_raw_fd(), REQUEST, None).unwrap().capacity(),
        REQUEST
    );
}

#[test]
fn requested_size_and_live_file_length_still_limit_each_read() {
    let fixture = Fixture::new(b"abcdef");
    let mut file = fixture.open();
    let first = read(file.as_raw_fd(), 2, None).unwrap();
    assert_eq!(first, b"ab");
    assert_eq!(first.capacity(), 2);
    file.seek(SeekFrom::Start(99)).unwrap();
    assert_eq!(read(file.as_raw_fd(), REQUEST, None).unwrap().capacity(), 0);
    fs::write(&fixture.0, b"abcdefghi").unwrap();
    assert_eq!(read(file.as_raw_fd(), REQUEST, Some(6)).unwrap(), b"ghi");
}

#[cfg(target_os = "linux")]
#[test]
fn eof_bound_does_not_hide_offset_plus_length_overflow() {
    let fixture = Fixture::new(b"abc");
    let mut file = fixture.open();
    assert_eq!(
        read(file.as_raw_fd(), REQUEST, Some(libc::off_t::MAX))
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EINVAL)
    );
    file.seek(SeekFrom::Start(libc::off_t::MAX as u64)).unwrap();
    assert_eq!(
        read(file.as_raw_fd(), REQUEST, None)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EINVAL)
    );
    assert_eq!(file.stream_position().unwrap(), libc::off_t::MAX as u64);
}
