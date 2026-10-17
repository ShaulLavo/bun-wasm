use super::{
    io::{self, Result},
    resolve,
};
use crate::Transpiler;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Local {
    pub path: PathBuf,
    pub meta: Value,
    pub workspace: bool,
}

pub fn root(parser: &dyn Transpiler) -> Result<Option<PathBuf>> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    for ancestor in cwd.ancestors().skip(1) {
        if !ancestor.join("package.json").exists() {
            continue;
        }
        let manifest = io::read(&ancestor.join("package.json"), "JSON", parser)?;
        if manifest.get("workspaces").is_none() {
            continue;
        }
        let members = workspaces(ancestor, &manifest, parser)?;
        if members.values().any(|member| member.path == cwd) {
            std::env::set_current_dir(ancestor).map_err(|e| e.to_string())?;
            return Ok(Some(cwd));
        }
    }
    Ok(None)
}

pub fn workspaces(root: &Path, manifest: &Value, parser: &dyn Transpiler) -> Result<BTreeMap<String, Local>> {
    let mut members = BTreeMap::new();
    let config = &manifest["workspaces"];
    if config.is_null() {
        return Ok(members);
    }
    let patterns = config
        .as_array()
        .or_else(|| config["packages"].as_array())
        .ok_or("workspaces must be an array or an object with packages")?;
    let mut paths = Vec::new();
    for pattern in patterns {
        let pattern = pattern.as_str().ok_or("workspace patterns must be strings")?;
        let (exclude, pattern) = pattern.strip_prefix('!').map_or((false, pattern), |p| (true, p));
        let pattern = format!("{}/package.json", pattern.trim_end_matches('/'));
        let mut walker = bun_glob::BunGlobWalker::init_with_cwd(
            pattern.as_bytes(),
            root.to_string_lossy().as_bytes(),
            false,
            true,
            false,
            false,
            true,
            None,
        )
        .map_err(|e| format!("Workspace glob: {e:?}"))?
        .map_err(|e| format!("Workspace glob: {e:?}"))?;
        walker
            .walk()
            .map_err(|e| format!("Workspace glob: {e:?}"))?
            .map_err(|e| format!("Workspace glob: {e:?}"))?;
        for path in walker.matched_paths.keys().iter() {
            let path = PathBuf::from(String::from_utf8_lossy(path).into_owned());
            if exclude {
                paths.retain(|p| p != &path);
            } else {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths.dedup();
    for path in paths {
        let meta = io::read(&path, "JSON", parser)?;
        let name = meta["name"]
            .as_str()
            .ok_or("Workspace package.json needs a name")?
            .to_owned();
        resolve::valid_name(&name)?;
        let local = Local {
            path: path.parent().unwrap().to_owned(),
            meta,
            workspace: true,
        };
        if members.insert(name.clone(), local).is_some() {
            return Err(format!("Duplicate workspace name: {name}"));
        }
    }
    Ok(members)
}

fn prepare_link(target: &Path, path: &Path) -> Result<Option<PathBuf>> {
    let parent = path.parent().ok_or("Invalid link path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let target = if target.is_absolute() {
        relative(target, &physical(parent)?)
    } else {
        target.to_owned()
    };
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.is_symlink() && fs::read_link(path).ok().as_deref() == Some(target.as_path()) {
            return Ok(None);
        }
        if meta.is_dir() && !meta.is_symlink() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(Some(target))
}

pub fn link(target: &Path, path: &Path) -> Result<()> {
    let Some(target) = prepare_link(target, path)? else {
        return Ok(());
    };
    super::super::natives::symlink(&target.to_string_lossy(), &path.to_string_lossy())
        .map_err(|e| e.to_string())
}

pub enum BinLink {
    Linked,
    Unsupported,
}

fn bin_link_result(result: std::io::Result<()>) -> Result<BinLink> {
    match result {
        Ok(()) => Ok(BinLink::Linked),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EPERM)) => {
            Ok(BinLink::Unsupported)
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn bin_link(target: &Path, path: &Path) -> Result<BinLink> {
    let Some(target) = prepare_link(target, path)? else {
        return Ok(BinLink::Linked);
    };
    bin_link_result(super::super::natives::symlink(
        &target.to_string_lossy(),
        &path.to_string_lossy(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_link_errors() {
        for code in [libc::ENOTSUP, libc::EPERM] {
            assert!(matches!(
                bin_link_result(Err(std::io::Error::from_raw_os_error(code))),
                Ok(BinLink::Unsupported)
            ));
        }
        for code in [libc::EACCES, libc::ENOENT, libc::EIO, libc::EEXIST, 76] {
            assert!(bin_link_result(Err(std::io::Error::from_raw_os_error(code))).is_err());
        }
        assert!(bin_link_result(Err(std::io::ErrorKind::PermissionDenied.into())).is_err());
        assert!(matches!(bin_link_result(Ok(())), Ok(BinLink::Linked)));
    }
}

pub fn lock_meta(meta: &Value) -> Value {
    let mut row = json!({});
    for field in [
        "name",
        "version",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if !meta[field].is_null() {
            row[field] = meta[field].clone();
        }
    }
    row
}

pub fn physical(path: &Path) -> Result<PathBuf> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut path = PathBuf::from(crate::resolve::normalize(&cwd.join(path).to_string_lossy()));
    for _ in 0..40 {
        let mut prefix = PathBuf::new();
        let mut redirected = None;
        for component in path.components() {
            prefix.push(component);
            let Ok(target) = fs::read_link(&prefix) else {
                continue;
            };
            let rest = path.strip_prefix(&prefix).map_err(|e| e.to_string())?;
            let target = prefix
                .parent()
                .ok_or("Invalid link parent")?
                .join(target)
                .join(rest);
            redirected = Some(PathBuf::from(crate::resolve::normalize(
                &target.to_string_lossy(),
            )));
            break;
        }
        let Some(next) = redirected else {
            return Ok(path);
        };
        path = next;
    }
    Err("Too many symbolic links in local dependency".into())
}

pub fn relative(target: &Path, base: &Path) -> PathBuf {
    for ancestor in base.ancestors() {
        let Ok(tail) = target.strip_prefix(ancestor) else {
            continue;
        };
        let mut path = PathBuf::new();
        for _ in base.strip_prefix(ancestor).unwrap().components() {
            path.push("..");
        }
        path.push(tail);
        if path.as_os_str().is_empty() {
            path.push(".");
        }
        return path;
    }
    target.to_owned()
}
