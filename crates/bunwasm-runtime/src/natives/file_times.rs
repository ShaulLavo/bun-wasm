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
    let (seconds, nanos) = clamp_to_timestamp(seconds as i64, nanos as i64);
    time.tv_sec = seconds as _;
    time.tv_nsec = nanos as _;
    Ok(time)
}

/// The latest time a WASI Preview1 timestamp (u64 nanoseconds since 1970) holds.
const LATEST: (i64, i64) = (18_446_744_073, 709_551_615);

/// WASI rejects a time past `LATEST` with EINVAL; native Bun's kernel call clamps it to
/// the filesystem's latest time instead, so clamp here and let the host clamp the rest
/// (ext4 stops in 2486). Native hosts clamp below `LATEST` anyway. Times before 1970
/// stay as they are: WASI cannot store them (EINVAL).
fn clamp_to_timestamp(seconds: i64, nanos: i64) -> (i64, i64) {
    if (seconds, nanos) <= LATEST {
        return (seconds, nanos);
    }
    LATEST
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
        [
            Val::Num(seconds),
            Val::Num(nanos),
            Val::Num(seconds),
            Val::Num(nanos),
        ]
    }

    #[test]
    fn negative_nanoseconds_mean_now() {
        let values = stamp(5.0, -1.0);
        let [atime, _] = times(&Args(&values), 0).unwrap();
        let mut now: libc::timespec = unsafe { std::mem::zeroed() };
        now.tv_nsec = libc::UTIME_NOW as _;
        assert_eq!(atime.tv_nsec, now.tv_nsec);
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

    // timespec fields are i64 here but c_long (i32) nanoseconds on wasm32.
    #[allow(clippy::unnecessary_cast)]
    #[test]
    fn times_past_the_wasi_range_clamp_to_its_end() {
        for seconds in [1e15, 9_007_199_254_740_991.0, 1e300] {
            let values = stamp(seconds, 0.0);
            let [atime, _] = times(&Args(&values), 0).unwrap();
            assert_eq!((atime.tv_sec as i64, atime.tv_nsec as i64), LATEST);
        }
        let values = stamp(18_446_744_073.0, 999_999_999.0);
        let [atime, _] = times(&Args(&values), 0).unwrap();
        assert_eq!((atime.tv_sec as i64, atime.tv_nsec as i64), LATEST);
        let values = stamp(4_039_372_800.0, 5.0);
        let [atime, _] = times(&Args(&values), 0).unwrap();
        assert_eq!(
            (atime.tv_sec as i64, atime.tv_nsec as i64),
            (4_039_372_800, 5)
        );
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
