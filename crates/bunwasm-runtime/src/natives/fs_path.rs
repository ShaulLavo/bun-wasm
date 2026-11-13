use std::io;

pub(crate) fn required(path: &str) -> io::Result<&str> {
    if path.is_empty() {
        return Err(io::ErrorKind::NotFound.into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_paths_fail_before_a_wasi_lookup_can_select_the_preopen() {
        assert_eq!(required("").unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn nonempty_paths_keep_the_callers_spelling() {
        for path in [".", "/", "./file", "dir/../file", "dir/", " "] {
            assert_eq!(required(path).unwrap(), path);
        }
    }
}
