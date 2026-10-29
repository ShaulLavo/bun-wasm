pub(crate) fn mode(file_type: u32) -> u32 {
    file_type
}

#[cfg(test)]
mod tests {
    use super::mode;

    #[test]
    fn preview1_files_have_readable_presentation_permissions() {
        assert_eq!(mode(0o100000), 0o100644);
        assert_ne!(mode(0o100000) & 0o400, 0);
    }

    #[test]
    fn preview1_directories_and_symlinks_retain_their_types() {
        assert_eq!(mode(0o040000), 0o040755);
        assert_eq!(mode(0o120000), 0o120777);
    }

    #[test]
    fn descriptor_kinds_are_not_reclassified_as_regular_files() {
        for kind in [0o010000, 0o020000, 0o060000, 0o140000] {
            assert_eq!(mode(kind) & 0o170000, kind);
            assert_ne!(mode(kind) & 0o400, 0);
        }
    }
}
