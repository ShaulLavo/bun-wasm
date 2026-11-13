use std::io;
use std::mem::MaybeUninit;

fn metadata(fd: libc::c_int) -> io::Result<libc::stat> {
    let mut stat = MaybeUninit::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

fn read_length(
    fd: libc::c_int,
    requested: usize,
    position: Option<libc::off_t>,
    metadata: io::Result<libc::stat>,
) -> usize {
    let Ok(stat) = metadata else {
        return requested;
    };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG || stat.st_size <= 0 {
        return requested;
    }
    let position = position.unwrap_or_else(|| unsafe { libc::lseek(fd, 0, libc::SEEK_CUR) });
    if position < 0 {
        return requested;
    }
    let Ok(length) = libc::off_t::try_from(requested) else {
        return requested;
    };
    // Shrinking an overflowing request could hide the syscall's range error.
    if position.checked_add(length).is_none() {
        return requested;
    }
    let remaining = stat.st_size.saturating_sub(position).max(0);
    requested.min(usize::try_from(remaining).unwrap_or(usize::MAX))
}

fn read_with_metadata(
    fd: libc::c_int,
    requested: usize,
    position: Option<libc::off_t>,
    metadata: impl FnOnce() -> io::Result<libc::stat>,
) -> io::Result<Vec<u8>> {
    let length = if requested == 0 {
        0
    } else {
        read_length(fd, requested, position, metadata())
    };
    let mut bytes = vec![0; length];
    // Even EOF and empty reads must let the syscall validate rights and offsets.
    let count = match position {
        Some(position) => unsafe {
            libc::pread(fd, bytes.as_mut_ptr().cast(), bytes.len(), position)
        },
        None => unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) },
    };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    bytes.truncate(count as usize);
    Ok(bytes)
}

pub(super) fn read(
    fd: libc::c_int,
    requested: usize,
    position: Option<libc::off_t>,
) -> io::Result<Vec<u8>> {
    read_with_metadata(fd, requested, position, || metadata(fd))
}

#[cfg(all(test, unix))]
#[path = "descriptor_read_tests.rs"]
mod tests;
