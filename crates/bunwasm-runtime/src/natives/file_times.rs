//! `utimes`, `lutimes` and `futimes`: the timespecs Bun's `time_like.rs` computes, set
//! through utimensat(2) and futimens(2). Errors carry Node's operation names
//! (`utime`, `lutime`, `futime`), not the kernel calls, as Bun reports them.

use std::ffi::CString;
use std::io;

use crate::data::{Args, NativeError};

/// One time from JS as two numbers: whole seconds (floored), then nanoseconds in
/// `0..1e9`. A negative nanosecond count asks for the current time (`UTIME_NOW`).
fn timespec(args: &Args<'_>, index: usize) -> Result<libc::timespec, NativeError> {
    let (seconds, nanos) = (args.num(index)?, args.num(index + 1)?);
    // Zeroed first: some targets' timespec has private padding fields.
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    if nanos < 0.0 {
        time.tv_nsec = libc::UTIME_NOW as _;
        return Ok(time);
    }
    time.tv_sec = seconds as _;
    time.tv_nsec = nanos as _;
    Ok(time)
}

/// The access then modification times starting at argument `index`.
pub(super) fn times(args: &Args<'_>, index: usize) -> Result<[libc::timespec; 2], NativeError> {
    Ok([timespec(args, index)?, timespec(args, index + 2)?])
}

pub(super) fn set_path(path: &str, times: &[libc::timespec; 2], follow: bool) -> io::Result<()> {
    let path = CString::new(path).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
    let status = unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), flags) };
    if status < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn set_descriptor(fd: i32, times: &[libc::timespec; 2]) -> io::Result<()> {
    if unsafe { libc::futimens(fd, times.as_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Val;

    fn stamp(seconds: f64, nanos: f64) -> [Val; 4] {
        [Val::Num(seconds), Val::Num(nanos), Val::Num(seconds), Val::Num(nanos)]
    }

    #[test]
    fn negative_nanoseconds_mean_now() {
        let values = stamp(5.0, -1.0);
        let [atime, _] = times(&Args(&values), 0).unwrap();
        assert_eq!(i64::from(atime.tv_nsec), libc::UTIME_NOW as i64);
    }

    #[test]
    fn sets_fractional_and_post_2038_times() {
        let dir = std::env::temp_dir().join(format!("bunwasm-file-times-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f");
        std::fs::write(&file, b"x").unwrap();
        let path = file.to_str().unwrap();
        // 2098-01-01T00:00:00.250Z
        let values = stamp(4_039_372_800.0, 250_000_000.0);
        set_path(path, &times(&Args(&values), 0).unwrap(), true).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        let since = modified.duration_since(std::time::UNIX_EPOCH).unwrap();
        assert_eq!(since.as_millis(), 4_039_372_800_250);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_paths_and_bad_descriptors_fail() {
        let values = stamp(1.0, 0.0);
        let pair = times(&Args(&values), 0).unwrap();
        let missing = set_path("/nonexistent-bunwasm-dir/f", &pair, true).unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
        let bad = set_descriptor(2_147_483_640, &pair).unwrap_err();
        assert_eq!(bad.raw_os_error(), Some(libc::EBADF));
    }
}
