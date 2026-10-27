fn check(error: io::Error, expected: (&str, i32, &str)) -> NativeError {
    let (code, errno, description) = expected;
    let with_path = io_error(error, "read", Some("/errno fixture"));
    assert_eq!(with_path.kind, data::ErrorKind::Error);
    assert_eq!(with_path.name, None);
    assert_eq!(
        with_path.message,
        format!("{code}: {description}, read '/errno fixture'")
    );
    assert_eq!(
        with_path.props,
        vec![
            ("path".into(), "/errno fixture".into()),
            ("syscall".into(), "read".into()),
            ("errno".into(), errno.into()),
            ("code".into(), code.into()),
        ]
    );
    with_path
}

fn main() {
    use io::ErrorKind as K;
    let kinds = [
        (K::BrokenPipe, ("EPIPE", -32, "broken pipe")),
        (K::NotFound, ("ENOENT", -2, "no such file or directory")),
        (K::AlreadyExists, ("EEXIST", -17, "file already exists")),
        (K::PermissionDenied, ("EACCES", -13, "permission denied")),
        (K::NotADirectory, ("ENOTDIR", -20, "not a directory")),
        (
            K::IsADirectory,
            ("EISDIR", -21, "illegal operation on a directory"),
        ),
        (
            K::DirectoryNotEmpty,
            ("ENOTEMPTY", -39, "directory not empty"),
        ),
        (K::InvalidInput, ("EINVAL", -22, "invalid argument")),
        (
            K::CrossesDevices,
            ("EXDEV", -18, "cross-device link not permitted"),
        ),
        (K::Unsupported, ("ENOSYS", -38, "function not implemented")),
        (
            K::ReadOnlyFilesystem,
            ("EROFS", -30, "read-only file system"),
        ),
        (
            K::FilesystemLoop,
            ("ELOOP", -40, "too many symbolic links encountered"),
        ),
        (K::InvalidFilename, ("ENAMETOOLONG", -36, "name too long")),
        (K::Other, ("EIO", -5, "i/o error")),
    ];
    for (kind, expected) in kinds {
        check(kind.into(), expected);
    }
    check(
        io::Error::from_raw_os_error(libc::EBADF),
        ("EBADF", -9, "bad file descriptor"),
    );
    check(
        io::Error::from_raw_os_error(libc::EIO),
        ("EIO", -5, "i/o error"),
    );
    check(
        io::Error::from_raw_os_error(i32::MAX),
        ("EIO", -5, "i/o error"),
    );
    let cases = [
        (libc::EMFILE, ("EMFILE", -24, "too many open files")),
        (libc::ENOMEM, ("ENOMEM", -12, "not enough memory")),
        (libc::ENOSPC, ("ENOSPC", -28, "no space left on device")),
        (
            libc::EAGAIN,
            ("EAGAIN", -11, "resource temporarily unavailable"),
        ),
    ];
    for (raw, expected) in cases {
        let with_path = check(io::Error::from_raw_os_error(raw), expected);
        let error = io_error(io::Error::from_raw_os_error(raw), "read", None);
        assert_eq!(
            error.props,
            vec![
                ("syscall".into(), "read".into()),
                ("errno".into(), expected.1.into()),
                ("code".into(), expected.0.into()),
            ]
        );
        assert_eq!(
            error.message,
            format!("{}: {}, read", expected.0, expected.2)
        );
        println!("{}\t{}\t{}", expected.0, error.message, with_path.message);
    }
    check(
        io::Error::from_raw_os_error(libc::EWOULDBLOCK),
        ("EAGAIN", -11, "resource temporarily unavailable"),
    );
}
