//! Bun's matcher and filesystem walker, shared by Bun.Glob and node:fs.
use crate::engine::{NativeError, Val};
use crate::natives::{Table, io_error};

pub fn install(t: &mut Table) {
    t.add("globMatch", |a| {
        Ok(
            bun_glob::r#match(a.str(0)?.as_bytes(), a.str(1)?.as_bytes())
                .matches()
                .into(),
        )
    });
    t.add("globScan", |a| {
        let pattern = a.str(0)?;
        let cwd = a.str(1)?;
        let mut walker = bun_glob::BunGlobWalker::init_with_cwd(
            pattern.as_bytes(),
            cwd.as_bytes(),
            a.bool(2),
            a.bool(3),
            a.bool(4),
            a.bool(5),
            a.bool(6),
            None,
        )
        .map_err(|e| NativeError::error(format!("Glob: {e:?}")))?
        .map_err(glob_error)?;
        if a.bool(7) {
            walker.follow_matched_symlinks();
        }
        walker
            .walk()
            .map_err(|e| NativeError::error(format!("Glob: {e:?}")))?
            .map_err(glob_error)?;
        Ok(Val::Array(
            walker
                .matched_paths
                .keys()
                .iter()
                .map(|p| Val::Str(String::from_utf8_lossy(p).into_owned()))
                .collect(),
        ))
    });
}

fn glob_error(e: bun_sys::Error) -> NativeError {
    let path = String::from_utf8_lossy(&e.path);
    io_error(
        std::io::Error::from_raw_os_error(e.errno as i32),
        "scandir",
        Some(&path),
    )
}
