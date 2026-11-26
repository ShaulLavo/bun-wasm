//! Paths removed when the process ends, such as the temporary installation `bun x` runs from
//! when the host keeps no install cache. Native engines finish inside the guest and run this
//! before exiting. The browser engine runs the program after `_start` returns, so its host
//! calls `bunwasm_exit_cleanup` when the program exits.
use std::{cell::RefCell, path::PathBuf};

thread_local! {
    static PATHS: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
}

/// Removes `path` (a directory) when the process ends.
pub fn remove_at_exit(path: PathBuf) {
    PATHS.with(|paths| paths.borrow_mut().push(path));
}

/// Removes every registered path. Running it again does nothing.
pub fn run() {
    let paths = PATHS.with(|paths| std::mem::take(&mut *paths.borrow_mut()));
    for path in paths {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bunwasm_exit_cleanup() {
    run();
}

#[cfg(test)]
mod tests {
    #[test]
    fn registered_directories_are_removed_once() {
        let root =
            std::env::temp_dir().join(format!("bun-wasm-exit-cleanup-{}", std::process::id()));
        std::fs::create_dir_all(root.join("inside")).unwrap();
        super::remove_at_exit(root.clone());
        super::run();
        assert!(!root.exists());
        super::run();
    }
}
